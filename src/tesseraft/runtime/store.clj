(ns tesseraft.runtime.store
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.edn :as edn]
    [clojure.pprint :as pprint]
    [clojure.string :as str]
    [tesseraft.credentials.store :as credentials]
    [tesseraft.persistence.safe-write :as safe-write]
    [tesseraft.security.redaction :as redaction]))

(def ^:dynamic *allow-runtime-claim-replacement* false)

(defn now [] (str (java.time.Instant/now)))

(defn sha256 [s]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256") (.getBytes s "UTF-8"))]
    (apply str (map #(format "%02x" (bit-and % 0xff)) digest))))

(defn write-edn! [p data]
  (safe-write/write-text! p (with-out-str (pprint/pprint data))))
(defn read-edn [p] (edn/read-string (slurp (str p))))
(defn write-json! [p data] (safe-write/write-json! p data))
(defn read-json [p] (json/parse-string (slurp (str p)) true))
(defn append-jsonl! [p data]
  (safe-write/append-text! p (str (json/generate-string data) "\n")))
(defn write-text! [p text] (safe-write/write-text! p text))
(defn append-text! [p text]
  (safe-write/append-text! p text))

(defn- runtime-options [ctx]
  (cond-> (select-keys (:run ctx) [:workspace-root :tesseraft-home :runs-root :workflow-roots])
    (:credential-resolver ctx) (assoc :credential-resolver (:credential-resolver ctx))))

(defn- persisted-project-context [ctx project-id]
  (let [project (get-in ctx [:run :project-context])
        persisted-id (or (:project_id project) (:project-id project))]
    (when (and (map? project) (= project-id persisted-id)) project)))

(defn- resolved-project-credential-secrets [ctx]
  (when-not (:skip-project-credential-redaction? ctx)
    (try
      (let [project-id (get-in ctx [:run :project-id])
            options (runtime-options ctx)
            project (persisted-project-context ctx project-id)]
        (when project
          (keep (fn [[_ conn]]
                  (when-let [ref (:credential-ref conn)]
                    (:value (credentials/resolve options ref))))
                (:connections project))))
      (catch Throwable _ nil))))

(defn- credential-secrets [ctx]
  (filter #(and (string? %) (not (str/blank? %)))
          (concat (:credential-secrets ctx) (resolved-project-credential-secrets ctx))))

(defn durable-data [ctx data]
  (redaction/redact data (credential-secrets ctx)))

(defn durable-text [ctx text]
  (redaction/redact-string text (credential-secrets ctx)))

(defn write-runtime-json! [ctx p data]
  (write-json! p (durable-data ctx data)))

(defn with-run-lock
  "Serialize a short run-directory mutation with an OS-owned file lock.
  Process death releases the lock; the durable lock file is never treated as
  ownership and never removed based on age."
  [run-dir f]
  (let [path (fs/path run-dir ".runtime-mutation.lock")]
    (fs/create-dirs (fs/parent path))
    (with-open [file (java.io.RandomAccessFile. (str path) "rw")
                channel (.getChannel file)]
      (loop [remaining 400]
        (if-let [lock (try (.tryLock channel) (catch Exception _ nil))]
          ;; Closing the channel in the outer with-open releases this OS lock.
          ;; Babashka intentionally does not expose FileLockImpl.release.
          (f)
          (do
            (when (zero? remaining)
              (throw (ex-info "Timed out waiting for the run mutation lock" {:run-dir (str run-dir)})))
            (Thread/sleep 25)
            (recur (dec remaining))))))))

(defn write-runtime-text! [ctx p text]
  (write-text! p (durable-text ctx text)))

(defn append-runtime-text! [ctx p text]
  (append-text! p (durable-text ctx text)))

(defn save-context! [ctx]
  ;; Resolver functions are live-process dependencies: use them to scrub the
  ;; durable value, but never serialize them into restartable run state.
  ;; Missing claim/fence data preserves current authority. A context carrying
  ;; an older fence or a replaced owner is stale and must fail rather than
  ;; overwrite cancellation or another execution.
  (let [path (fs/path (get-in ctx [:run :dir]) "state.edn")
        current (when (fs/exists? path) (read-edn path))
        durable-claim (:runtime-claim current)
        incoming-claim (:runtime-claim ctx)
        durable-generation (or (:execution-cancel-generation current) 0)
        incoming-generation (or (:execution-cancel-generation ctx) durable-generation)
        _ (when (and (contains? ctx :execution-cancel-generation)
                     (< incoming-generation durable-generation))
            (throw (ex-info "Runtime context carries an obsolete cancellation fence"
                            {:code :runtime_cancel_fenced
                             :context-generation incoming-generation
                             :durable-generation durable-generation})))
        _ (when (and incoming-claim (< (or (:cancel-generation incoming-claim) 0) durable-generation))
            (throw (ex-info "Runtime context was invalidated by cancellation"
                            {:code :runtime_cancel_fenced
                             :claim-generation (:cancel-generation incoming-claim)
                             :durable-generation durable-generation})))
        _ (when (and incoming-claim durable-claim
                     (not= (:execution-id incoming-claim) (:execution-id durable-claim))
                     (not *allow-runtime-claim-replacement*))
            (throw (ex-info "Runtime context no longer owns the durable claim"
                            {:code :runtime_claim_lost
                             :claim (:execution-id incoming-claim)
                             :owner (:execution-id durable-claim)})))
        preserved (cond-> (assoc ctx :execution-cancel-generation incoming-generation)
                    (and (not (contains? ctx :runtime-claim)) durable-claim)
                    (assoc :runtime-claim durable-claim)
                    (and (not (contains? ctx :execution-cancel-in-progress))
                         (:execution-cancel-in-progress current))
                    (assoc :execution-cancel-in-progress (:execution-cancel-in-progress current)))]
    (write-edn! path
                (durable-data preserved (assoc (dissoc preserved :credential-resolver) :record-version 2)))
    preserved))

(defn load-context [run-dir]
  (let [ctx (read-edn (fs/path run-dir "state.edn"))
        version (or (:record-version ctx) 1)]
    (case version
      1 (assoc ctx :record-version 2)
      2 ctx
      (throw (ex-info "Unsupported run-state record version"
                      {:code :unsupported-run-state-version :version version :run-dir (str run-dir)})))))

(defn- mirrored-event
  "A namespaced copy of a scrubbed nested event for the parent's own log: the
  original :event is prefixed \"fragment.\", the parent's own :state/:attempt
  (from the descriptor) replace the nested ones, and the nested :state/:attempt
  (when present) are preserved under :internal_state/:internal_attempt so the
  parent log alone can reconstruct which internal node produced it."
  [descriptor event]
  (cond-> (-> event
              (dissoc :state :attempt)
              (assoc :event (str "fragment." (:event event))
                     :state (:state descriptor)
                     :attempt (:attempt descriptor)))
    (contains? event :state) (assoc :internal_state (:state event))
    (contains? event :attempt) (assoc :internal_attempt (:attempt event))
    (:fragment descriptor) (assoc :fragment (:fragment descriptor))))

(defn- event-id-present? [ctx event-id]
  (let [path (fs/path (get-in ctx [:run :dir]) "events.jsonl")]
    (boolean
      (when (fs/exists? path)
        (some #(= event-id (:event_id (json/parse-string % true)))
              (remove str/blank? (str/split-lines (slurp (str path)))))))))

(defn event! [ctx event]
  ;; A fragment-internal ctx carries a data-only :event-mirror descriptor
  ;; (parent run dir, state, attempt, fragment name) set at creation and
  ;; persisted through save-context!/reload, so the mirrored copy below is
  ;; written into the parent's events.jsonl as the event happens -- the parent
  ;; trace must exist even if the process dies mid-fragment, not only once the
  ;; nested run finishes. Mirroring appends directly (not via event!), so it
  ;; never recurses.
  (let [scrubbed (durable-data ctx (assoc event :at (now)))]
    (append-jsonl! (fs/path (get-in ctx [:run :dir]) "events.jsonl") scrubbed)
    (when-let [descriptor (:event-mirror ctx)]
      (append-jsonl! (fs/path (:parent-dir descriptor) "events.jsonl")
                     (mirrored-event descriptor scrubbed))))
  ctx)

(defn event-once!
  "Append an event with a stable event_id at most once. Malformed existing
  event lines fail closed instead of allowing a duplicate proof record."
  [ctx event]
  (let [event-id (:event_id event)]
    (if (and event-id (event-id-present? ctx event-id)) ctx (event! ctx event))))

(defn ensure-run-dirs! [ctx]
  (doseq [d ["logs" "prompts/generated" "pi-sessions" "sessions" "attempts"]]
    (fs/create-dirs (fs/path (get-in ctx [:run :dir]) d)))
  (when-not (fs/exists? (get-in ctx [:run :issues-file]))
    (write-json! (get-in ctx [:run :issues-file]) []))
  ctx)
