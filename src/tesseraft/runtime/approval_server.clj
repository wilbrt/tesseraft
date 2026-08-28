(ns tesseraft.runtime.approval-server
  "Transient loopback adapter for top-level git-diff approvals.

  Durable request, evidence, decision, feedback, state, and events remain the
  authority. The adapter owns only a capability and exact process metadata."
  (:require [babashka.fs :as fs]
            [babashka.process :as process]
            [clojure.string :as str]
            [tesseraft.runtime.store :as store]))

(def default-max-diff-bytes (* 2 1024 1024))
(def max-max-diff-bytes (* 10 1024 1024))

(defn evidence-path [ctx approval-id]
  (fs/path (get-in ctx [:run :dir]) "approval-evidence" approval-id "changes.diff"))
(defn owner-dir [ctx state-id attempt]
  (fs/path (get-in ctx [:run :dir]) "approval-adapters" (name state-id) (str attempt)))
(defn owner-path [ctx state-id attempt] (fs/path (owner-dir ctx state-id attempt) "owner.json"))
(defn capability-path [ctx state-id attempt] (fs/path (owner-dir ctx state-id attempt) "capability.json"))

(defn- command! [dir args]
  (let [result @(process/process args {:dir (str dir) :out :string :err :string :continue true
                                      :extra-env {"GIT_OPTIONAL_LOCKS" "0"
                                                  "GIT_NO_LAZY_FETCH" "1"
                                                  "GIT_NO_REPLACE_OBJECTS" "1"
                                                  "GIT_PAGER" "cat"}})]
    (when-not (zero? (:exit result))
      (throw (ex-info "Git review snapshot command failed"
                      {:code :git_snapshot_failed :command (vec args)
                       :exit (:exit result) :stderr (subs (str (:err result)) 0 (min 1000 (count (str (:err result)))))})))
    (:out result)))

(defn- assert-conversion-free! [repo]
  (let [autocrlf (str/trim (or (:out @(process/process ["git" "config" "--get" "core.autocrlf"]
                                                       {:dir (str repo) :out :string :err :string :continue true})) ""))
        conversion-config (or (:out @(process/process ["git" "config" "--name-only" "--get-regexp"
                                                        "^(core\\.eol|core\\.attributesfile|filter\\..*\\.(clean|smudge|process|required))$"]
                                                       {:dir (str repo) :out :string :err :string :continue true})) "")
        tracked-attrs (or (:out @(process/process ["git" "ls-files" "--" "**/.gitattributes" ".gitattributes"]
                                                    {:dir (str repo) :out :string :err :string :continue true})) "")
        worktree-attrs (seq (fs/glob repo "**/.gitattributes"))]
    (when (or (and (not (str/blank? autocrlf)) (not= "false" (str/lower-case autocrlf)))
              (not (str/blank? conversion-config))
              (not (str/blank? tracked-attrs)) worktree-attrs)
      (throw (ex-info "Git-diff review requires a conversion-free worktree"
                      {:code :unsupported_git_conversion})))))

(defn snapshot-diff!
  "Create bounded immutable review evidence for tracked changes. Configuration
  that could execute or transform worktree content is rejected before diffing."
  [ctx approval-id max-bytes]
  (let [requested (or max-bytes default-max-diff-bytes)
        _ (when-not (and (integer? requested) (<= 1 requested max-max-diff-bytes))
            (throw (ex-info "review-server max-diff-bytes must be 1..10485760"
                            {:code :invalid_review_diff_bound})))
        supplied (or (get-in ctx [:run :worktree-dir]) (get-in ctx [:inputs :repo-root]) ".")
        repo (fs/real-path (fs/path (str/trim (command! supplied ["git" "rev-parse" "--show-toplevel"]))))
        _ (assert-conversion-free! repo)
        diff (command! repo ["git" "-c" "core.fsmonitor=false" "--no-pager" "diff"
                             "--no-ext-diff" "--no-textconv" "--unified=3" "HEAD" "--"])
        bytes (.getBytes diff "UTF-8")]
    (when (zero? (alength bytes))
      (throw (ex-info "There are no tracked Git changes to review" {:code :no_reviewable_changes})))
    (when (or (str/includes? diff "GIT binary patch") (str/includes? diff "Binary files "))
      (throw (ex-info "Binary changes are not supported by git-diff review" {:code :unsupported_binary_diff})))
    (when (> (alength bytes) requested)
      (throw (ex-info "Git review diff exceeds the authored byte bound"
                      {:code :review_diff_too_large :size (alength bytes) :limit requested})))
    (let [path (evidence-path ctx approval-id)]
      (fs/create-dirs (fs/parent path))
      (store/write-runtime-text! ctx path diff)
      {:path (str (fs/relativize (fs/path (get-in ctx [:run :dir])) path))
       :sha256 (store/sha256 diff) :size (alength bytes) :max_bytes requested})))

(defn diff-anchors [diff]
  (loop [lines (map-indexed vector (str/split-lines diff)) file nil old nil new nil anchors {}]
    (if-let [[idx line] (first lines)]
      (cond
        (str/starts-with? line "+++ ")
        (recur (rest lines) (when-not (= "+++ /dev/null" line) (str/replace (subs line 4) #"^b/" "")) old new anchors)

        (str/starts-with? line "@@ ")
        (let [[_ old-start new-start] (re-find #"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@" line)]
          (recur (rest lines) file (some-> old-start parse-long) (some-> new-start parse-long) anchors))

        (and old new file (or (str/starts-with? line "+") (str/starts-with? line "-") (str/starts-with? line " ")))
        (let [artifact-line (inc idx)
              plus? (str/starts-with? line "+") minus? (str/starts-with? line "-")
              anchor (cond plus? {:kind "diff" :file file :side "new" :line new :artifact_line artifact-line}
                           minus? {:kind "diff" :file file :side "old" :line old :artifact_line artifact-line}
                           :else {:kind "diff" :file file :side "new" :line new :artifact_line artifact-line})]
          (recur (rest lines) file (if plus? old (inc old)) (if minus? new (inc new))
                 (assoc anchors (str artifact-line) anchor)))
        :else (recur (rest lines) file old new anchors))
      anchors)))

(defn invalid-annotation [ctx request annotation]
  (when-let [review (:review_server request)]
    (let [path (fs/path (get-in ctx [:run :dir]) (:evidence_path review))
          diff (when (fs/exists? path) (slurp (str path)))
          anchor (:anchor annotation)
          artifact-line (:artifact_line anchor)
          expected (when (and diff (integer? artifact-line)) (get (diff-anchors diff) (str artifact-line)))]
      (cond
        (nil? diff) "approval evidence is unavailable"
        (not= (store/sha256 diff) (:evidence_sha256 review)) "approval evidence hash does not match"
        (nil? expected) "annotation must anchor an annotatable diff line"
        (not= expected (select-keys anchor [:kind :file :side :line :artifact_line]))
        "annotation anchor does not match the reviewed diff line"
        (and (:start_line anchor) (not= (:start_line anchor) (:line expected))) "annotation start_line does not match"
        (and (:end_line anchor) (not= (:end_line anchor) (:line expected))) "annotation end_line does not match"
        :else nil))))

(defn- token []
  (let [bytes (byte-array 32)]
    (.nextBytes (java.security.SecureRandom.) bytes)
    (.encodeToString (.withoutPadding (java.util.Base64/getUrlEncoder)) bytes)))

(defn- adapter-script []
  (let [root (or (System/getenv "TESSERAFT_INSTALL_ROOT") (System/getProperty "user.dir"))
        script (fs/path root "web" "approval-adapter.js")]
    (when-not (fs/exists? script)
      (throw (ex-info "Approval adapter script is unavailable" {:code :approval_adapter_unavailable :path (str script)})))
    (str script)))

(defn launch! [ctx state-id attempt request]
  (let [dir (owner-dir ctx state-id attempt)
        owner (owner-path ctx state-id attempt)
        secret (token)
        pb (ProcessBuilder. ^java.util.List ["node" (adapter-script)
                                             "--run-dir" (get-in ctx [:run :dir])
                                             "--state" (name state-id) "--attempt" (str attempt)
                                             "--approval-id" (:approval_id request)])]
    (fs/create-dirs dir)
    (.redirectOutput pb (.toFile (fs/path dir "adapter.log")))
    (.redirectError pb (.toFile (fs/path dir "adapter-error.log")))
    (.put (.environment pb) "AGENT_RUN_DIR" (str (get-in ctx [:run :dir])))
    (let [child (.start pb)
          started (some-> child .toHandle .info .startInstant (.orElse nil) str)
          record {:version 1 :run_id (get-in ctx [:run :id]) :state (name state-id) :attempt attempt
                  :approval_id (:approval_id request) :pid (.pid child) :process_started_at started
                  :capability_hash (store/sha256 secret) :status "launching" :created_at (store/now)}]
      (store/write-runtime-json! ctx owner record)
      (with-open [writer (java.io.OutputStreamWriter. (.getOutputStream child) "UTF-8")]
        (.write writer secret))
      (store/event! ctx {:event "approval.adapter.launched" :state (name state-id) :attempt attempt
                         :approval_id (:approval_id request) :pid (.pid child)})
      record)))

(defn cleanup! [ctx]
  (let [root (fs/path (get-in ctx [:run :dir]) "approval-adapters")]
    (when (fs/exists? root)
      (doseq [owner (fs/glob root "**/owner.json")]
        (try
          (let [record (store/read-json owner)
                pid (:pid record)
                candidate (when (integer? pid) (java.lang.ProcessHandle/of (long pid)))
                handle (when (and candidate (.isPresent candidate)) (.get candidate))
                actual (some-> handle .info .startInstant (.orElse nil) str)]
            (when (and handle (.isAlive handle) (= actual (:process_started_at record)))
              (.destroy handle)
              (try (.get (.onExit handle) 3 java.util.concurrent.TimeUnit/SECONDS) (catch Throwable _ (.destroyForcibly handle))))
            (fs/delete-if-exists (fs/path (fs/parent owner) "capability.json"))
            (store/write-runtime-json! ctx owner (assoc record :status "stopped" :stopped_at (store/now))))
          (catch Throwable _ nil))))
    ctx))
