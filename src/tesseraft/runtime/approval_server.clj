(ns tesseraft.runtime.approval-server
  "Transient loopback adapter for top-level git-diff approvals.

  Durable request, evidence, decision, feedback, state, and events remain the
  authority. The adapter owns only a capability and exact process metadata."
  (:require [babashka.fs :as fs]
            [babashka.process :as process]
            [cheshire.core :as json]
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

(defn- install-root []
  (or (System/getenv "TESSERAFT_INSTALL_ROOT") (System/getProperty "user.dir")))

(defn- snapshot-helper []
  (let [script (fs/path (install-root) "scripts" "git_diff_snapshot.py")]
    (when-not (fs/exists? script)
      (throw (ex-info "Secure Git snapshot helper is unavailable"
                      {:code :secure_worktree_traversal_unavailable :path (str script)})))
    (str script)))

(defn- helper-snapshot! [repo max-bytes]
  (let [input (json/generate-string {:repo (str repo) :max_diff_bytes max-bytes})
        result @(process/process [(or (System/getenv "TESSERAFT_PYTHON") "python") (snapshot-helper)]
                                 {:in input :out :string :err :string :continue true})
        payload (try (json/parse-string (or (:out result) "") true)
                     (catch Throwable _ nil))]
    (when-not (:ok payload)
      (let [error (:error payload)
            code (some-> (:code error) keyword)]
        (throw (ex-info (or (:message error) "Secure Git snapshot failed")
                        {:code (or code :git_snapshot_failed)
                         :details (:details error)
                         :exit (:exit result)
                         :stderr (subs (str (:err result)) 0 (min 1000 (count (str (:err result)))))}))))
    (try
      {:diff (String. (.decode (java.util.Base64/getDecoder) ^String (:diff_base64 payload)) "UTF-8")
       :size (:size payload)
       :head-tree (:head_tree payload)
       :index-fingerprint (:index_fingerprint payload)
       :context-fingerprint (:context_fingerprint payload)}
      (catch Throwable error
        (throw (ex-info "Secure Git snapshot returned malformed evidence"
                        {:code :malformed_git_snapshot} error))))))

(defn snapshot-diff!
  "Create bounded immutable review evidence for tracked changes. Configuration
  that could execute or transform worktree content is rejected before diffing."
  [ctx approval-id max-bytes]
  (let [requested (or max-bytes default-max-diff-bytes)
        _ (when-not (and (integer? requested) (<= 1 requested max-max-diff-bytes))
            (throw (ex-info "review-server max-diff-bytes must be 1..10485760"
                            {:code :invalid_review_diff_bound})))
        supplied (or (get-in ctx [:run :worktree-dir]) (get-in ctx [:inputs :repo-root]) ".")
        snapshot (helper-snapshot! supplied requested)
        diff (:diff snapshot)
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
       :sha256 (store/sha256 diff) :size (alength bytes) :max_bytes requested
       :head_tree (:head-tree snapshot)
       :index_fingerprint (:index-fingerprint snapshot)
       :context_fingerprint (:context-fingerprint snapshot)})))

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
  (let [script (fs/path (install-root) "web" "approval-adapter.js")]
    (when-not (fs/exists? script)
      (throw (ex-info "Approval adapter script is unavailable" {:code :approval_adapter_unavailable :path (str script)})))
    (str script)))

(defn- owner-process [record]
  (let [pid (:pid record)
        candidate (when (and (integer? pid) (pos? pid)) (java.lang.ProcessHandle/of (long pid)))
        handle (when (and candidate (.isPresent candidate)) (.get candidate))
        actual (some-> handle .info .startInstant (.orElse nil) str)]
    {:handle handle :actual-start actual
     :exact-live (boolean (and handle (.isAlive handle) (= actual (:process_started_at record))))}))

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

(defn ensure-adapter!
  "Adopt one exact live adapter or relaunch after its PID/start tuple is proven
  absent. A reused PID is never signalled. This is called only by mutating
  blocked-run reconciliation, never by pure inspection."
  [ctx state-id attempt request]
  (let [path (owner-path ctx state-id attempt)
        capability (capability-path ctx state-id attempt)
        record (when (fs/exists? path) (store/read-json path))]
    (when (and record
               (not= [(:run_id record) (:state record) (:attempt record) (:approval_id record)]
                     [(get-in ctx [:run :id]) (name state-id) attempt (:approval_id request)]))
      (throw (ex-info "Approval adapter owner tuple does not match blocked approval"
                      {:code :approval_adapter_owner_mismatch})))
    (let [{:keys [exact-live]} (when record (owner-process record))]
      (if exact-live
        record
        (do
          (when record
            (fs/delete-if-exists capability)
            (store/write-runtime-json! ctx path
              (assoc record :status "stale" :stale_at (store/now))))
          (let [launched (launch! ctx state-id attempt request)]
            (store/event-once! ctx {:event "approval.adapter.recovered"
                                    :event_id (str (:approval_id request) "/adapter-recovered/" (:pid launched))
                                    :state (name state-id) :attempt attempt
                                    :approval_id (:approval_id request) :pid (:pid launched)})
            launched))))))

(defn reconcile-blocked! [ctx]
  (let [state-id (get-in ctx [:run :state])
        attempt (get-in ctx [:run :attempt])
        approval-id (str (name state-id) "-" attempt)
        request-path (fs/path (get-in ctx [:run :dir]) "approvals" (str approval-id ".json"))
        request (when (fs/exists? request-path) (store/read-json request-path))]
    (when (:review_server request)
      (ensure-adapter! ctx state-id attempt request))
    ctx))

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
