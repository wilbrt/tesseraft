(ns tesseraft.runtime.store
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.edn :as edn]
    [clojure.pprint :as pprint]
    [clojure.string :as str]))

(defn now [] (str (java.time.Instant/now)))

(defn sha256 [s]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256") (.getBytes s "UTF-8"))]
    (apply str (map #(format "%02x" (bit-and % 0xff)) digest))))

(defn write-edn! [p data]
  (fs/create-dirs (fs/parent p))
  (spit (str p) (with-out-str (pprint/pprint data)))
  p)
(defn read-edn [p] (edn/read-string (slurp (str p))))
(defn write-json! [p data]
  (fs/create-dirs (fs/parent p))
  (spit (str p) (json/generate-string data {:pretty true}))
  p)
(defn read-json [p] (json/parse-string (slurp (str p)) true))
(defn append-jsonl! [p data]
  (fs/create-dirs (fs/parent p))
  (spit (str p) (str (json/generate-string data) "\n") :append true)
  p)
(defn write-text! [p text]
  (fs/create-dirs (fs/parent p))
  (spit (str p) text)
  p)
(defn append-text! [p text]
  (fs/create-dirs (fs/parent p))
  (spit (str p) text :append true)
  p)

(defn- redact-value [s secrets]
  (reduce (fn [acc secret]
            (if (and (string? secret) (not (str/blank? secret)))
              (str/replace acc secret "[redacted]")
              acc))
          s
          secrets))

(defn- scrub-secrets [x secrets]
  (cond
    (string? x) (redact-value x secrets)
    (map? x) (into {} (map (fn [[k v]] [k (scrub-secrets v secrets)])) x)
    (vector? x) (mapv #(scrub-secrets % secrets) x)
    (seq? x) (mapv #(scrub-secrets % secrets) x)
    :else x))

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
      (let [resolve-project (requiring-resolve 'tesseraft.control-plane.core/resolve-project)
            project-context-opts (requiring-resolve 'tesseraft.control-plane.core/project-context-opts)
            project-scoped-opts (requiring-resolve 'tesseraft.control-plane.core/project-scoped-opts)
            resolve-credential (requiring-resolve 'tesseraft.control-plane.core/resolve-credential)
            project-id (get-in ctx [:run :project-id])
            options (runtime-options ctx)
            persisted-project (persisted-project-context ctx project-id)
            project (or persisted-project (resolve-project options project-id))
            scoped (if persisted-project
                     (project-context-opts options persisted-project)
                     (when-not (:error project) (project-scoped-opts options project-id)))]
        (when-not (or (:error project) (:error scoped))
          (keep (fn [[_ conn]]
                  (when-let [ref (:credential-ref conn)]
                    (:value (resolve-credential scoped ref))))
                (:connections project))))
      (catch Throwable _ nil))))

(defn- credential-secrets [ctx]
  (filter #(and (string? %) (not (str/blank? %)))
          (concat (:credential-secrets ctx) (resolved-project-credential-secrets ctx))))

(defn durable-data [ctx data]
  (scrub-secrets data (credential-secrets ctx)))

(defn durable-text [ctx text]
  (redact-value (str text) (credential-secrets ctx)))

(defn write-runtime-json! [ctx p data]
  (write-json! p (durable-data ctx data)))

(defn write-runtime-text! [ctx p text]
  (write-text! p (durable-text ctx text)))

(defn append-runtime-text! [ctx p text]
  (append-text! p (durable-text ctx text)))

(defn save-context! [ctx]
  ;; Resolver functions are live-process dependencies: use them to scrub the
  ;; durable value, but never serialize them into restartable run state.
  (write-edn! (fs/path (get-in ctx [:run :dir]) "state.edn")
              (durable-data ctx (dissoc ctx :credential-resolver)))
  ctx)

(defn load-context [run-dir]
  (read-edn (fs/path run-dir "state.edn")))

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
  (doseq [d ["logs" "prompts/generated" "pi-sessions" "attempts"]]
    (fs/create-dirs (fs/path (get-in ctx [:run :dir]) d)))
  (when-not (fs/exists? (get-in ctx [:run :issues-file]))
    (write-json! (get-in ctx [:run :issues-file]) []))
  ctx)
