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
  (select-keys (:run ctx) [:workspace-root :tesseraft-home :runs-root :workflow-roots]))

(defn- resolved-project-credential-secrets [ctx]
  (try
    (let [resolve-project (requiring-resolve 'tesseraft.control-plane.core/resolve-project)
          project-scoped-opts (requiring-resolve 'tesseraft.control-plane.core/project-scoped-opts)
          resolve-credential (requiring-resolve 'tesseraft.control-plane.core/resolve-credential)
          project-id (get-in ctx [:run :project-id])
          options (runtime-options ctx)
          project (resolve-project options project-id)
          scoped (when-not (:error project) (project-scoped-opts options project-id))]
      (when-not (or (:error project) (:error scoped))
        (keep (fn [[_ conn]]
                (when-let [ref (:credential-ref conn)]
                  (:value (resolve-credential scoped ref))))
              (:connections project))))
    (catch Throwable _ nil)))

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
  (write-edn! (fs/path (get-in ctx [:run :dir]) "state.edn") (durable-data ctx ctx))
  ctx)

(defn load-context [run-dir]
  (read-edn (fs/path run-dir "state.edn")))

(defn event! [ctx event]
  (append-jsonl! (fs/path (get-in ctx [:run :dir]) "events.jsonl")
                (durable-data ctx (assoc event :at (now))))
  ctx)

(defn ensure-run-dirs! [ctx]
  (doseq [d ["logs" "prompts/generated" "pi-sessions" "attempts"]]
    (fs/create-dirs (fs/path (get-in ctx [:run :dir]) d)))
  (when-not (fs/exists? (get-in ctx [:run :issues-file]))
    (write-json! (get-in ctx [:run :issues-file]) []))
  ctx)
