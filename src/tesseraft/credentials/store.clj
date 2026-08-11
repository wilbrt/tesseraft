(ns tesseraft.credentials.store
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.string :as str]
    [tesseraft.persistence.safe-write :as safe-write]
    [tesseraft.credentials.refs :as refs]))

(def version 1)

(defn tesseraft-home [options]
  (or (:tesseraft-home options)
      (System/getenv "TESSERAFT_HOME")
      (str (fs/path (System/getProperty "user.home") ".tesseraft"))))

(defn path [options]
  (fs/path (tesseraft-home options) "credentials.json"))

(defn read-store [options]
  (let [credentials-path (path options)]
    (when (fs/exists? credentials-path)
      (json/parse-string (slurp (str credentials-path)) true))))

(defn valid? [data]
  (and (map? data) (= version (:version data)) (map? (:credentials data))
       (every? string? (vals (:credentials data)))))

(defn local-value [options credential-path]
  (let [data (read-store options)]
    (when (valid? data)
      (or (get-in data [:credentials credential-path])
          (get-in data [:credentials (keyword credential-path)])))))

(defn production-resolver [options ref]
  (let [[_ store-name credential-path] (re-matches refs/credential-ref-re (str ref))]
    (case store-name
      "env" (let [value (System/getenv credential-path)]
              (if (str/blank? value)
                {:present false :state "absent" :credential-ref ref}
                {:present true :state "present" :credential-ref ref :value value}))
      "tesseraft" (let [data (read-store options)]
                    (cond
                      (nil? data) {:present false :state "absent" :credential-ref ref}
                      (not (valid? data)) {:present false :state "invalid" :credential-ref ref
                                           :error "invalid local credential store"}
                      :else (let [value (local-value options credential-path)]
                              (if (str/blank? value)
                                {:present false :state "absent" :credential-ref ref}
                                {:present true :state "present" :credential-ref ref :value value}))))
      "github-actions" {:present false :state "unresolved" :credential-ref ref
                        :unresolved "github-actions store not wired for local resolution"}
      {:present false :state "unresolved" :credential-ref ref
       :unresolved (str "unknown store: " store-name)})))

(defn resolve [options ref]
  (cond
    (str/blank? (str ref)) {:present false :state "absent"}
    (not (refs/credential-ref? ref)) {:present false :state "invalid" :error "invalid credential-ref"}
    :else
    (try
      (let [injected? (some? (:credential-resolver options))
            resolver (or (:credential-resolver options) production-resolver)
            result (resolver options ref)
            valid-result? (and (map? result)
                               (boolean? (:present result))
                               (contains? #{"present" "absent" "unresolved" "invalid"} (:state result))
                               (if (= "present" (:state result))
                                 (and (:present result) (string? (:value result)) (not (str/blank? (:value result))))
                                 (not (:present result))))]
        (if-not valid-result?
          {:present false :state "invalid" :credential-ref ref :error "credential resolver failed"}
          (cond-> {:present (:present result) :state (:state result) :credential-ref ref}
            (= "present" (:state result)) (assoc :value (:value result))
            (= "invalid" (:state result)) (assoc :error (if injected? "credential resolver reported invalid"
                                                            (or (:error result) "invalid credential")))
            (= "unresolved" (:state result)) (assoc :unresolved (if injected? "credential resolver unavailable"
                                                                    (or (:unresolved result) "credential resolver unavailable"))))))
      (catch Throwable _
        {:present false :state "invalid" :credential-ref ref :error "credential resolver failed"}))))

(defn put! [options credential-path value]
  (when-not (and (string? credential-path) (not (str/blank? credential-path)))
    (throw (ex-info "Credential path must be a non-empty string" {:code :invalid-credential-path})))
  (when-not (and (string? value) (not (str/blank? value)))
    (throw (ex-info "Credential value must be a non-empty string" {:code :invalid-credential-value})))
  (let [data (or (read-store options) {:version version :credentials {}})]
    (when-not (valid? data)
      (throw (ex-info "Credential store is invalid" {:code :invalid-credential-store})))
    (safe-write/write-json! (path options)
                            (assoc-in data [:credentials (keyword credential-path)] value)
                            {:owner-only? true})
    {:credential-ref (str "tesseraft:" credential-path) :state "present"}))

(defn delete! [options credential-path]
  (let [data (or (read-store options) {:version version :credentials {}})
        existed? (or (contains? (:credentials data) credential-path)
                     (contains? (:credentials data) (keyword credential-path)))
        updated (update data :credentials #(dissoc % credential-path (keyword credential-path)))]
    (safe-write/write-json! (path options) updated {:owner-only? true})
    {:credential-ref (str "tesseraft:" credential-path) :deleted existed?}))
