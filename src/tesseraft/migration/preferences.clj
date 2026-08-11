(ns tesseraft.migration.preferences
  (:require
    [babashka.fs :as fs]
    [tesseraft.persistence.safe-write :as safe-write]
    [tesseraft.preferences.store :as preferences]
    [tesseraft.runtime.store :as store]))

(def ^:private preference-fields
  #{:pi_default_provider :pi_default_model :default_repo_root :color_scheme :editor_layout})
(def ^:private token-fields
  {:github_token "legacy/github-token"
   :jira_token "legacy/jira-token"})

(defn- paths [options]
  (let [workspace (fs/absolutize (or (:workspace-root options) "."))
        home (or (:tesseraft-home options)
                 (System/getenv "TESSERAFT_HOME")
                 (str (fs/path (System/getProperty "user.home") ".tesseraft")))]
    {:home home
     :legacy [(fs/path home "settings.json")
              (fs/path workspace ".tesseraft" "settings.json")]
     :preferences (preferences/path home)
     :credentials (fs/path home "credentials.json")
     :provenance (fs/path home "migrations" "project-settings-v1.json")}))

(defn- readable-settings [path]
  (when (fs/exists? path)
    (let [raw (store/read-json path)]
      (when-not (map? raw)
        (throw (ex-info "Legacy settings must be a JSON object" {:path (str path)})))
      {:path (str path) :raw raw :bytes (slurp (str path))})))

(defn inspect [options]
  (try
    (let [{:keys [home legacy preferences credentials provenance]} (paths options)
          sources (vec (keep readable-settings legacy))
          merged (apply merge (map :raw sources))
          migrated-prefs (select-keys merged preference-fields)
          migrated-creds (into {} (keep (fn [[field dest]]
                                          (when-let [value (get merged field)] [dest value])))
                               token-fields)
          current-prefs (preferences/read! home)
          current-creds-raw (if (fs/exists? credentials) (store/read-json credentials) {:version 1 :credentials {}})
          current-creds (if (map? (:credentials current-creds-raw))
                          (assoc current-creds-raw :credentials
                                 (into {} (map (fn [[key value]] [(name key) value]) (:credentials current-creds-raw))))
                          current-creds-raw)
          pref-conflicts (for [[key value] migrated-prefs
                               :let [existing (get-in current-prefs [:preferences key])]
                               :when (and (some? existing) (not= existing value))]
                           {:code "preference_conflict" :field (name key)
                            :message "A canonical preference already has a different value"})
          credential-conflicts (for [[key value] migrated-creds
                                     :let [existing (get-in current-creds [:credentials (keyword key)])]
                                     :when (and (some? existing) (not= existing value))]
                                 {:code "credential_conflict" :field key
                                  :message "A canonical credential already has a different value"})
          invalid-credential-store (when-not (and (= 1 (:version current-creds)) (map? (:credentials current-creds)))
                                     [{:code "invalid_credential_store"
                                       :message "Canonical credential store is invalid"}])
          conflicts (vec (concat pref-conflicts credential-conflicts invalid-credential-store))
          applicable (+ (count migrated-prefs) (count migrated-creds))]
      {:ok (empty? conflicts)
       :operation "migration.preferences.inspect"
       :state (cond (seq conflicts) "conflict" (pos? applicable) "pending" :else "current")
       :applicable applicable
       :sources (mapv :path sources)
       :destinations {:preferences (str preferences)
                      :credentials (str credentials)
                      :provenance (str provenance)}
       :conflicts conflicts
       :plan {:sources sources
              :preferences (preferences/update-values current-prefs migrated-prefs)
              :credentials {:version 1 :credentials (merge (:credentials current-creds) migrated-creds)}
              :migrated-fields (vec (concat (keys migrated-prefs)
                                            (for [[field _] token-fields :when (contains? merged field)] field)))}})
    (catch Throwable t
      {:ok false :operation "migration.preferences.inspect" :state "conflict" :applicable 0
       :conflicts [{:code "unreadable_legacy_settings" :message (.getMessage t)
                    :path (:path (ex-data t))}]})))

(defn migrate! [options mode]
  (let [report (inspect options)
        public (dissoc report :plan)]
    (cond
      (seq (:conflicts report)) (assoc public :operation "migration.preferences" :mode (name mode))
      (= :dry-run mode) (assoc public :operation "migration.preferences" :mode "dry-run")
      (not= :apply mode) (assoc public :ok false :state "error"
                           :error {:code "bad_request" :message "Migration mode must be dry-run or apply"})
      (zero? (:applicable report)) (assoc public :operation "migration.preferences" :mode "apply" :state "unchanged")
      :else
      (let [{:keys [preferences credentials provenance]} (:destinations report)
            {:keys [sources migrated-fields]} (:plan report)
            touched (atom [])]
        (try
          (doseq [path [preferences credentials]
                  :when (fs/exists? path)]
            (let [backup (str path ".v1.backup")]
              (safe-write/backup-once! path backup {:owner-only? true})
              (swap! touched conj {:path path :backup backup})))
          (safe-write/write-json! preferences (get-in report [:plan :preferences]) {:owner-only? true})
          (safe-write/write-json! credentials (get-in report [:plan :credentials]) {:owner-only? true})
          (doseq [{:keys [path raw]} sources]
            (let [backup (str path ".v1.backup")
                  remaining (apply dissoc raw (concat preference-fields (keys token-fields)))]
              (safe-write/backup-once! path backup {:owner-only? true})
              (swap! touched conj {:path path :backup backup})
              (safe-write/write-json! path remaining {:owner-only? true})))
          (safe-write/write-json! provenance
                                 {:version 1
                                  :migration "legacy-settings-to-preferences-and-credentials"
                                  :sources (mapv (fn [{:keys [path bytes]}]
                                                   {:path path :sha256 (store/sha256 bytes)}) sources)
                                  :migrated_fields (mapv name migrated-fields)}
                                 {:owner-only? true})
          (assoc (dissoc (inspect options) :plan) :operation "migration.preferences"
                 :mode "apply" :state "migrated" :backups (mapv :backup @touched))
          (catch Throwable t
            (doseq [{:keys [path backup]} (reverse @touched)]
              (try (safe-write/write-text! path (slurp backup) {:owner-only? true}) (catch Throwable _ nil)))
            {:ok false :operation "migration.preferences" :mode "apply" :state "failed"
             :error {:code "migration_failed" :message (.getMessage t)}}))))))
