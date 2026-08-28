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
  "Serialize a short run-directory mutation across runtime/control-plane
  processes. The lock file is durable but contains no state; the authoritative
  mutation records remain state.edn, events.jsonl, and the run artifacts."
  [run-dir f]
  (let [lock-path (.toPath (fs/file (fs/path run-dir ".runtime-mutation.lock")))
        attributes (make-array java.nio.file.attribute.FileAttribute 0)
        acquire!
        (fn []
          (loop [remaining 400]
            (let [acquired? (try
                              (java.nio.file.Files/createFile lock-path attributes)
                              true
                              (catch java.nio.file.FileAlreadyExistsException _ false))]
              (if acquired?
                true
                (let [age-ms (try
                               (- (System/currentTimeMillis)
                                  (.toMillis (java.nio.file.Files/getLastModifiedTime lock-path (make-array java.nio.file.LinkOption 0))))
                               (catch Throwable _ 0))]
                  ;; A process can die between atomic create and cleanup. A
                  ;; minute-old lock cannot belong to this millisecond-scale
                  ;; mutation and is safe to reclaim.
                  (when (> age-ms 60000)
                    (try (java.nio.file.Files/deleteIfExists lock-path) (catch Throwable _ nil)))
                  (when (zero? remaining)
                    (throw (ex-info "Timed out waiting for the run mutation lock" {:run-dir (str run-dir)})))
                  (Thread/sleep 25)
                  (recur (dec remaining)))))))]
    (acquire!)
    (try
      (f)
      (finally
        (java.nio.file.Files/deleteIfExists lock-path)))))

(defn write-runtime-text! [ctx p text]
  (write-text! p (durable-text ctx text)))

(defn append-runtime-text! [ctx p text]
  (append-text! p (durable-text ctx text)))

(defn save-context! [ctx]
  ;; Resolver functions are live-process dependencies: use them to scrub the
  ;; durable value, but never serialize them into restartable run state.
  (write-edn! (fs/path (get-in ctx [:run :dir]) "state.edn")
              (durable-data ctx (assoc (dissoc ctx :credential-resolver) :record-version 2)))
  ctx)

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

(defn ensure-run-dirs! [ctx]
  (doseq [d ["logs" "prompts/generated" "pi-sessions" "sessions" "attempts"]]
    (fs/create-dirs (fs/path (get-in ctx [:run :dir]) d)))
  (when-not (fs/exists? (get-in ctx [:run :issues-file]))
    (write-json! (get-in ctx [:run :issues-file]) []))
  ctx)
