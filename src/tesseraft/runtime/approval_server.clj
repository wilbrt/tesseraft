(ns tesseraft.runtime.approval-server
  "Transient loopback adapter for top-level git-diff approvals.

  Durable request, evidence, decision, feedback, state, and events remain the
  authority. The adapter owns only a capability and exact process metadata."
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.string :as str]
            [tesseraft.runtime.process :as runtime-process]
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

(defn- read-helper-line! [^java.io.BufferedReader reader ^Process child]
  (let [pending (future (.readLine reader))
        line (deref pending 35000 ::timeout)]
    (when (= ::timeout line)
      (.destroyForcibly child)
      (throw (ex-info "Secure Git snapshot helper timed out"
                      {:code :snapshot_publication_timeout})))
    (when (nil? line)
      (throw (ex-info "Secure Git snapshot helper exited without a receipt"
                      {:code :malformed_git_snapshot})))
    (try (json/parse-string line true)
         (catch Throwable error
           (throw (ex-info "Secure Git snapshot returned malformed evidence"
                           {:code :malformed_git_snapshot} error))))))

(defn- assert-helper-ok! [payload phase]
  (when-not (and (:ok payload) (= phase (:phase payload)))
    (let [error (:error payload)]
      (throw (ex-info (or (:message error) "Secure Git snapshot failed")
                      {:code (or (some-> (:code error) keyword) :git_snapshot_failed)
                       :details (:details error) :phase phase}))))
  payload)

(defn- helper-snapshot! [ctx repo max-bytes path]
  (let [pb (ProcessBuilder. ^java.util.List
                            [(or (System/getenv "TESSERAFT_PYTHON") "python") (snapshot-helper)])
        barrier-dir (or (System/getProperty "tesseraft.test.snapshot-barrier-dir")
                        (System/getenv "TESSERAFT_TEST_SNAPSHOT_BARRIER_DIR"))]
    (when barrier-dir
      (.put (.environment pb) "TESSERAFT_TEST_SNAPSHOT_BARRIER_DIR" barrier-dir))
    (fs/create-dirs (fs/parent path))
    (let [child (.start pb)]
      (try
        (with-open [writer (java.io.BufferedWriter. (java.io.OutputStreamWriter. (.getOutputStream child) "UTF-8"))
                    reader (java.io.BufferedReader. (java.io.InputStreamReader. (.getInputStream child) "UTF-8"))]
          (.write writer (str (json/generate-string {:repo (str repo) :max_diff_bytes max-bytes}) "\n"))
          (.flush writer)
          (let [prepared (assert-helper-ok! (read-helper-line! reader child) "prepared")
                diff (try
                       (String. (.decode (java.util.Base64/getDecoder) ^String (:diff_base64 prepared)) "UTF-8")
                       (catch Throwable error
                         (throw (ex-info "Secure Git snapshot returned malformed evidence"
                                         {:code :malformed_git_snapshot} error))))]
            (when-not (and (= (:size prepared) (alength (.getBytes diff "UTF-8")))
                           (= (:sha256 prepared) (store/sha256 diff)))
              (throw (ex-info "Secure Git snapshot candidate receipt does not match its bytes"
                              {:code :malformed_git_snapshot})))
            (store/write-runtime-text! ctx path diff)
            (let [installed (slurp (str path))]
              (.write writer (str (json/generate-string {:command "published" :sha256 (store/sha256 installed)}) "\n"))
              (.flush writer))
            (let [confirmed (assert-helper-ok! (read-helper-line! reader child) "confirmed")]
              (when-not (and (= (:sha256 prepared) (:sha256 confirmed))
                             (= (:sha256 confirmed) (store/sha256 (slurp (str path)))))
                (throw (ex-info "Installed evidence does not match the confirmed snapshot"
                                {:code :unstable_worktree_snapshot})))
              {:diff diff :size (:size prepared) :head-tree (:head_tree prepared)
               :index-fingerprint (:index_fingerprint prepared)
               :context-fingerprint (:context_fingerprint prepared)
               :watch-provider (:watch_provider confirmed)
               :watch-count (:watch_count confirmed)
               :watch-overflow (:watch_overflow confirmed)})))
        (catch Throwable error
          (fs/delete-if-exists path)
          (throw error))
        (finally
          (when (.isAlive child) (.destroyForcibly child)))))))

(defn snapshot-diff!
  "Create bounded immutable review evidence for tracked changes. Configuration
  that could execute or transform worktree content is rejected before diffing."
  [ctx approval-id max-bytes]
  (let [requested (or max-bytes default-max-diff-bytes)
        _ (when-not (and (integer? requested) (<= 1 requested max-max-diff-bytes))
            (throw (ex-info "review-server max-diff-bytes must be 1..10485760"
                            {:code :invalid_review_diff_bound})))
        supplied (or (get-in ctx [:run :worktree-dir]) (get-in ctx [:inputs :repo-root]) ".")
        path (evidence-path ctx approval-id)
        snapshot (helper-snapshot! ctx supplied requested path)
        diff (:diff snapshot)
        bytes (.getBytes diff "UTF-8")]
    (when (zero? (alength bytes))
      (throw (ex-info "There are no tracked Git changes to review" {:code :no_reviewable_changes})))
    (when (or (str/includes? diff "GIT binary patch") (str/includes? diff "Binary files "))
      (throw (ex-info "Binary changes are not supported by git-diff review" {:code :unsupported_binary_diff})))
    (when (> (alength bytes) requested)
      (throw (ex-info "Git review diff exceeds the authored byte bound"
                      {:code :review_diff_too_large :size (alength bytes) :limit requested})))
    {:path (str (fs/relativize (fs/path (get-in ctx [:run :dir])) path))
     :sha256 (store/sha256 diff) :size (alength bytes) :max_bytes requested
     :head_tree (:head-tree snapshot)
     :index_fingerprint (:index-fingerprint snapshot)
     :context_fingerprint (:context-fingerprint snapshot)
     :watch_provider (:watch-provider snapshot)
     :watch_count (:watch-count snapshot)
     :watch_overflow (:watch-overflow snapshot)}))

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

(defn owner-process [record]
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
    (when-let [delay (or (System/getProperty "tesseraft.test.adapter-exit-delay-ms")
                         (System/getenv "TESSERAFT_TEST_ADAPTER_EXIT_DELAY_MS"))]
      (.put (.environment pb) "TESSERAFT_TEST_ADAPTER_EXIT_DELAY_MS" delay))
    (when (= "true" (System/getProperty "tesseraft.test.adapter-hold-after-abort"))
      (.put (.environment pb) "TESSERAFT_TEST_ADAPTER_HOLD_AFTER_ABORT" "true"))
    (when-let [generation (System/getProperty "tesseraft.test.drain-hold-through-generation")]
      (.put (.environment pb) "TESSERAFT_TEST_DRAIN_HOLD_THROUGH_GENERATION" generation))
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

(defn- drain-path [ctx state-id attempt submission-id]
  (fs/path (owner-dir ctx state-id attempt) "drains" (str submission-id ".json")))

(defn- current-process-record []
  (let [handle (java.lang.ProcessHandle/current)]
    {:pid (.pid handle)
     :process_started_at (some-> handle .info .startInstant (.orElse nil) str)}))

(defn supervise-drain!
  "CAS-claim one durable drain generation, complete exact adapter teardown, and
  publish one lifecycle/handoff receipt. A duplicate live worker adopts; a
  proven-dead worker is replaced by the next generation."
  [{:keys [run_dir state attempt approval_id pid process_started_at submission_id transport_status] :as request}]
  (let [state-id (keyword state)
        ctx0 (store/load-context run_dir)
        path (owner-path ctx0 state-id attempt)
        capability (capability-path ctx0 state-id attempt)
        receipt-path (drain-path ctx0 state-id attempt submission_id)
        expected-adapter {:pid pid :process_started_at process_started_at}
        worker (current-process-record)
        claim
        (store/with-run-lock run_dir
          (fn []
            (let [ctx (store/load-context run_dir)
                  owner (when (fs/exists? path) (store/read-json path))
                  existing (when (fs/exists? receipt-path) (store/read-json receipt-path))
                  exact-owner? (= [pid process_started_at approval_id]
                                  [(:pid owner) (:process_started_at owner) (:approval_id owner)])
                  receipt-bound? (= [submission_id approval_id pid process_started_at transport_status]
                                    [(:submission_id existing) (:approval_id existing)
                                     (:adapter_pid existing) (:process_started_at existing)
                                     (:transport_status existing)])
                  same-approval-replacement? (= [(get-in ctx [:run :id]) state attempt approval_id]
                                                [(:run_id owner) (:state owner) (:attempt owner)
                                                 (:approval_id owner)])
                  safe-replacement? (and receipt-bound? same-approval-replacement?
                                         (not (:exact-live (owner-process expected-adapter))))
                  existing-worker {:pid (:worker_pid existing)
                                   :process_started_at (:worker_started_at existing)}
                  other-live? (and existing
                                   (not= [(:pid worker) (:process_started_at worker)]
                                         [(:worker_pid existing) (:worker_started_at existing)])
                                   (:exact-live (owner-process existing-worker)))]
              (cond
                (= "complete" (:lifecycle_status existing))
                {:status :complete :record existing}

                (and (not exact-owner?) (not safe-replacement?))
                {:status :superseded}

                other-live?
                {:status :adopted :record existing}

                :else
                (let [generation (inc (or (:drain_generation existing) 0))
                      claimed {:version 2 :submission_id submission_id :approval_id approval_id
                               :adapter_pid pid :process_started_at process_started_at
                               :transport_status transport_status :drain_generation generation
                               :phase "claimed" :worker_pid (:pid worker)
                               :worker_started_at (:process_started_at worker)
                               :claimed_at (store/now)}]
                  (store/write-runtime-json! ctx receipt-path claimed)
                  {:status :claimed :generation generation :record claimed})))))]
    (cond
      (= :adopted (:status claim))
      (let [record (:record claim)
            prior-worker {:pid (:worker_pid record) :process_started_at (:worker_started_at record)}
            released? (loop [remaining 400]
                        (let [current (when (fs/exists? receipt-path) (store/read-json receipt-path))]
                          (cond (= "complete" (:lifecycle_status current)) true
                                (not (:exact-live (owner-process prior-worker))) true
                                (zero? remaining) false
                                :else (do (Thread/sleep 25) (recur (dec remaining))))))]
        (if released?
          (supervise-drain! request)
          {:handoff :adopted :run-dir run_dir}))

      (not= :claimed (:status claim))
      {:handoff (:status claim) :run-dir run_dir}

      :else
      (let [hold-through (some-> (or (System/getProperty "tesseraft.test.drain-hold-through-generation")
                                      (System/getenv "TESSERAFT_TEST_DRAIN_HOLD_THROUGH_GENERATION"))
                                  parse-long)
            _ (when (and (= "aborted" transport_status)
                         hold-through (<= (:generation claim) hold-through))
                ;; Deterministic aborted-drain fault barrier only; production has no hold value.
                (loop [] (Thread/sleep 1000) (recur)))
            wait-absent (fn [attempts]
                          (loop [remaining attempts]
                            (let [{:keys [exact-live]} (owner-process expected-adapter)]
                              (cond (not exact-live) true
                                    (zero? remaining) false
                                    :else (do (Thread/sleep 50) (recur (dec remaining)))))))]
        (when-not (wait-absent 100)
          (let [{:keys [handle exact-live]} (owner-process expected-adapter)]
            (when exact-live (.destroyForcibly ^java.lang.ProcessHandle handle)))
          (when-not (wait-absent 100)
            (throw (ex-info "Exact approval adapter did not stop after bounded drain"
                            {:code :approval_adapter_drain_timeout :pid pid}))))
        (store/with-run-lock run_dir
          (fn []
            ;; This lock follows canonical run.decide, so decision presence is
            ;; determinate before lifecycle and handoff completion.
            (let [ctx (store/load-context run_dir)
                  owner (when (fs/exists? path) (store/read-json path))
                  current (store/read-json receipt-path)
                  exact-generation? (= [(:generation claim) (:pid worker) (:process_started_at worker)]
                                       [(:drain_generation current) (:worker_pid current) (:worker_started_at current)])
                  exact-owner? (= [pid process_started_at approval_id]
                                  [(:pid owner) (:process_started_at owner) (:approval_id owner)])
                  decision-path (fs/path run_dir "approvals" (str approval_id "-decision.json"))
                  decision? (fs/exists? decision-path)
                  terminal? (contains? #{"done" "failed" "error" "cancelled"} (get-in ctx [:run :status]))
                  pending? (and (not decision?) (= "blocked" (get-in ctx [:run :status]))
                                (= state-id (get-in ctx [:run :state]))
                                (= attempt (get-in ctx [:run :attempt])))
                  handoff (cond terminal? :not-applicable
                                (and decision? (not= "blocked" (get-in ctx [:run :status]))) :resume-requested
                                (and pending? exact-owner?) :relaunch-requested
                                pending? :adopted
                                :else :not-applicable)]
              (if-not exact-generation?
                {:handoff :superseded :run-dir run_dir}
                (let [completed (cond-> (assoc current :phase "finished" :listener_absent true
                                                :lifecycle_status "complete"
                                                :completed_at (store/now))
                                  (= handoff :resume-requested) (assoc :resume_handoff_status "requested")
                                  (= handoff :relaunch-requested) (assoc :relaunch_handoff_status "requested"))
                      finalization-path (fs/path run_dir "approval-finalizations" (str approval_id ".json"))
                      handoff-ctx (if (= handoff :resume-requested)
                                    (runtime-process/request-handoff-intent ctx approval_id)
                                    ctx)
                      intent-id (when (= handoff :resume-requested)
                                  (:active-execution-intent-id handoff-ctx))]
                  ;; A replacement adapter owns a different tuple/capability;
                  ;; never delete or overwrite it while completing this drain.
                  (when exact-owner?
                    (fs/delete-if-exists capability)
                    (store/write-runtime-json! ctx path
                      (assoc owner :status "stopped" :lifecycle_status "complete"
                             :stop_reason "detached-supervisor" :stopped_at (store/now))))
                  (store/write-runtime-json! ctx receipt-path completed)
                  (when (and decision? (fs/exists? finalization-path))
                    (store/write-runtime-json! ctx finalization-path
                      (cond-> (assoc (store/read-json finalization-path)
                                :lifecycle_status "complete" :transport_status transport_status
                                :drain_submission_id submission_id
                                :drain_generation (:generation claim)
                                :lifecycle_completed_at (store/now))
                        (= handoff :resume-requested) (assoc :resume_handoff_status "requested"))))
                  (when intent-id
                    (binding [store/*allow-execution-intent-update* true]
                      (store/save-context! handoff-ctx)))
                  (store/event-once! handoff-ctx {:event "approval.adapter.lifecycle-complete"
                                                  :event_id (str approval_id "/drain/" submission_id)
                                                  :approval_id approval_id :submission_id submission_id
                                                  :drain_generation (:generation claim)
                                                  :transport_status transport_status
                                                  :execution_intent_id intent-id})
                  (if (= handoff :relaunch-requested)
                    (let [request (store/read-json (fs/path run_dir "approvals" (str approval_id ".json")))]
                      (ensure-adapter! ctx state-id attempt request)
                      {:handoff :relaunched :run-dir run_dir :drain-generation (:generation claim)})
                    {:handoff handoff :run-dir run_dir :drain-generation (:generation claim)
                     :execution-intent-id intent-id}))))))))))

(defn reconcile-drains!
  "External bounded reconciler for incomplete focused-approval drains. Durable
  receipts remain authority: exact live workers are skipped and a proven-dead
  generation is reclaimed only by supervise-drain!'s run-lock CAS."
  [run-dir]
  (let [_ (store/load-context run-dir)
        root (fs/path run-dir "approval-adapters")]
    (if-not (fs/exists? root)
      []
      (let [paths (vec (take 257 (fs/glob root "**/drains/*.json")))]
        (when (> (count paths) 256)
          (throw (ex-info "Focused approval drain reconciliation exceeds 256 receipts"
                          {:code :approval_drain_reconcile_bound_exceeded :limit 256})))
        (->> paths
           (keep (fn [path]
                   (let [receipt (store/read-json path)
                         owner-file (fs/path (fs/parent (fs/parent path)) "owner.json")
                         owner (when (fs/exists? owner-file) (store/read-json owner-file))
                         worker {:pid (:worker_pid receipt)
                                 :process_started_at (:worker_started_at receipt)}]
                     (when (and owner
                                (not= "complete" (:lifecycle_status receipt))
                                (not (:exact-live (owner-process worker))))
                       (supervise-drain!
                         {:run_dir (str run-dir)
                          :state (:state owner)
                          :attempt (:attempt owner)
                          :approval_id (:approval_id receipt)
                          :pid (:adapter_pid receipt)
                          :process_started_at (:process_started_at receipt)
                          :submission_id (:submission_id receipt)
                          :transport_status (:transport_status receipt)})))))
           vec)))))

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
