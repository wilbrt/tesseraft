(ns tesseraft.project.connections
  (:require
    [clojure.string :as str]
    [tesseraft.credentials.refs :as credential-refs]
    [tesseraft.work-tracker.catalog :as work-tracker-catalog]))

(def credential-ref-re credential-refs/credential-ref-re)

(def ^:private raw-secret-key-names
  #{"token" "apikey" "accesstoken" "password" "secret"})

(defn- raw-secret-key? [k]
  (let [normalized (str/replace (str/lower-case (name k)) #"[_-]" "")]
    (or (contains? raw-secret-key-names normalized)
        (str/ends-with? normalized "token"))))

(defn contains-raw-secret-key? [x]
  (cond
    (map? x) (boolean (some (fn [[k v]]
                              (or (raw-secret-key? k)
                                  (contains-raw-secret-key? v)))
                            x))
    (sequential? x) (boolean (some contains-raw-secret-key? x))
    :else false))

(defn credential-ref? [s]
  (credential-refs/credential-ref? s))

(defn normalize-key [k]
  (keyword (str/replace (if (keyword? k) (name k) (str k)) #"_" "-")))

(defn normalize-keys-shallow [m]
  (into {} (map (fn [[k v]] [(normalize-key k) v]) m)))

(defn- unsupported-fields [m allowed]
  (seq (remove allowed (keys m))))

(defn- validate-work-tracker-config [provider config]
  (let [schema (work-tracker-catalog/descriptor provider)]
    (cond
      (nil? schema) {:message (str "Unsupported work-tracker provider: " (name provider))}
      (not (map? config)) {:message "work-tracker config must be an object"}
      :else
      (let [config* (normalize-keys-shallow config)
            fields (:form-fields schema)
            required (set (map :name (filter :required fields)))
            allowed (set (map :name fields))]
        (cond
          (seq (unsupported-fields config* allowed))
          {:message (str "Unsupported work-tracker config fields: "
                         (str/join ", " (map name (unsupported-fields config* allowed))))}
          (seq (remove #(contains? config* %) required))
          {:message (str "Missing work-tracker config fields: "
                         (str/join ", " (map name (remove #(contains? config* %) required))))}
          :else
          (when-let [err (work-tracker-catalog/validate-config provider config*)]
            {:message err}))))))

(defn normalize-work-tracker
  "Normalize and validate a work-tracker envelope. Returns a normalized map,
  `nil`, or `{:error <message>}`."
  [raw]
  (when (some? raw)
    (cond
      (not (map? raw)) {:error "work-tracker must be an object"}
      (contains-raw-secret-key? raw) {:error "Raw secret payloads are not accepted; provide a credential-ref instead"}
      :else
      (let [m (normalize-keys-shallow raw)
            provider-raw (:provider m)
            provider (when (or (string? provider-raw) (keyword? provider-raw)) (normalize-key provider-raw))
            config (when (map? (:config m)) (normalize-keys-shallow (:config m)))
            version (:schema-version m)]
        (cond
          (seq (unsupported-fields m #{:provider :schema-version :credential-ref :config}))
          {:error "work-tracker contains unknown fields"}
          (and (contains? m :schema-version) (not= 1 version))
          {:error "Unsupported work-tracker schema-version"}
          (nil? provider)
          {:error "work-tracker provider is required and must be a string"}
          (not (credential-ref? (:credential-ref m)))
          {:error "Invalid work-tracker credential-ref"}
          (not (map? (:config m)))
          {:error "work-tracker config must be an object"}
          :else
          (if-let [err (validate-work-tracker-config provider config)]
            {:error (:message err)}
            {:provider (name provider)
             :credential-ref (:credential-ref m)
             :config config}))))))

(defn- normalize-code-host [raw]
  (let [m (normalize-keys-shallow raw)
        auth-mode (or (:auth-mode m) "credential-ref")]
    (cond-> {:provider (or (:provider m) "github")
             :auth-mode auth-mode}
      (contains? m :credential-ref) (assoc :credential-ref (:credential-ref m)))))

(defn normalize-connection-entry [k v]
  (let [k* (normalize-key k)]
    (cond
      (not (map? v)) nil
      (= :work-tracker k*) (let [n (normalize-work-tracker v)] (when-not (:error n) [k* n]))
      (= :code-host k*) [k* (normalize-code-host v)]
      :else nil)))

(defn normalize-connections [connections]
  (if (map? connections)
    (into {} (keep (fn [[k v]] (normalize-connection-entry k v)) connections))
    {}))

(defn validate-connections [connections prefix]
  (cond
    (and (some? connections) (not (map? connections))) (str prefix " connections must be an object")
    (nil? connections) nil
    :else
    (let [conn* (normalize-keys-shallow connections)
          unknown (seq (remove #{:code-host :work-tracker} (keys conn*)))]
      (cond
        unknown (str prefix " connections contains unknown fields")
        :else
        (or
          (some (fn [[k v]]
                  (cond
                    (not (map? v)) (str "invalid " prefix " connection: " (name k))
                    (= :work-tracker k) (let [n (normalize-work-tracker v)] (:error n))
                    (= :code-host k)
                    (let [m (normalize-keys-shallow v)]
                      (cond
                        (seq (unsupported-fields m #{:provider :credential-ref :auth-mode}))
                        (str "invalid " prefix " connection: code-host")
                        (not= "github" (:provider m))
                        (str "invalid " prefix " connection: code-host")
                        (not (contains? #{"credential-ref" "ambient"} (:auth-mode m)))
                        (str "invalid " prefix " connection: code-host")
                        (and (= "credential-ref" (:auth-mode m))
                             (not (credential-ref? (:credential-ref m))))
                        (str "invalid " prefix " connection: code-host")
                        (and (= "ambient" (:auth-mode m)) (contains? m :credential-ref))
                        (str "invalid " prefix " connection: code-host")
                        :else nil))
                    :else nil))
                conn*)
          nil)))))
