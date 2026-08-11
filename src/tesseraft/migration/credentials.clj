(ns tesseraft.migration.credentials
  (:require
    [babashka.fs :as fs]
    [clojure.string :as str]
    [tesseraft.credentials.store :as credentials]
    [tesseraft.persistence.safe-write :as safe-write]
    [tesseraft.runtime.store :as store]))

(defn- error-response [status code message & [details]]
  {:status status :error {:code code :message message :details (or details {})}})

(defn- key-string [k]
  (if (keyword? k) (if-let [ns (namespace k)] (str ns "/" (name k)) (name k)) (str k)))

(defn- flat-store? [value]
  (and (map? value) (seq value) (not (contains? value :version))
       (every? (fn [[k v]] (and (not (str/blank? (key-string k)))
                                (string? v) (not (str/blank? v)))) value)))

(defn migrate!
  ([options legacy-file] (migrate! options :apply legacy-file))
  ([options mode legacy-file]
  (let [source (when-not (str/blank? (str legacy-file)) (fs/path legacy-file))
        target (credentials/path options)
        same? (and source
                   (= (str (fs/normalize (fs/absolutize source)))
                      (str (fs/normalize (fs/absolutize target)))))
        backup (fs/path (str target ".legacy.json"))]
    (cond
      (not (contains? #{:dry-run :apply} mode))
      (error-response 400 "bad_request" "credentials migrate requires --dry-run or --apply")
      (nil? source) (error-response 400 "bad_request" "credentials migrate requires --legacy-file")
      (not (fs/exists? source)) (error-response 400 "invalid_local_credential_store" "Legacy credential file is not readable" {:legacy_file (str source)})
      :else
      (try
        (let [legacy (store/read-json source)]
          (if (and same? (credentials/valid? legacy) (fs/exists? backup))
            {:status 200 :state "unchanged" :credentials_file (str target)
             :backup_file (str backup)}
            (if-not (flat-store? legacy)
              (error-response 400 "invalid_local_credential_store"
                              "Legacy credential file must be a flat object of non-empty string values")
              (let [migrated {:version credentials/version
                              :credentials (into {}
                                                 (map (fn [[k v]] [(keyword (key-string k)) v]) legacy))}
                    existing (when (and (fs/exists? target) (not same?))
                               (store/read-json target))]
                (cond
                  (= existing migrated)
                  {:status 200 :state "unchanged" :credentials_file (str target)}

                  (and existing (not= existing migrated))
                  (error-response 409 "conflict"
                                  "Destination credential store already exists and will not be overwritten")

                  (= mode :dry-run)
                  (cond-> {:status 200
                           :state "pending"
                           :credentials_count (count legacy)
                           :credentials_file (str target)}
                    same? (assoc :backup_file (str backup)))

                  :else
                  (do
                    (when same?
                      (safe-write/backup-once! source backup {:owner-only? true}))
                    (safe-write/write-json! target migrated {:owner-only? true})
                    (cond-> {:status 201
                             :state "migrated"
                             :credentials_count (count legacy)
                             :credentials_file (str target)}
                      same? (assoc :backup_file (str backup)))))))))
        (catch Throwable t
          (error-response 400 "migration_failed"
                          "Local credential migration could not be completed"
                          {:message (.getMessage t)})))))))
