(ns tesseraft.migration.project
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.string :as str]
    [tesseraft.migration.legacy.project :as legacy]
    [tesseraft.persistence.safe-write :as safe-write]
    [tesseraft.project.descriptor :as descriptor]
    [tesseraft.project.registry :as registry]
    [tesseraft.runtime.store :as store]))

(defn- package-version []
  (try
    (:version (store/read-json (fs/path (System/getProperty "user.dir") "package.json")))
    (catch Throwable _ "unknown")))

(defn- nearest-root [start]
  (loop [dir (fs/normalize (fs/absolutize (fs/path start)))]
    (let [candidate (descriptor/path dir)
          parent (fs/parent dir)]
      (cond
        (fs/exists? candidate) dir
        (or (nil? parent) (= dir parent)) nil
        :else (recur parent)))))

(defn- descriptor-change [root]
  (when root
    (let [path (descriptor/path root)]
      (when (fs/exists? path)
        (try
          (let [bytes (slurp (str path))
                raw (json/parse-string bytes true)]
            (cond
              (= descriptor/version (:version raw))
              (if-let [error (descriptor/validate raw)]
                {:kind "descriptor" :path (str path) :state "conflict"
                 :conflicts [{:code "invalid_v2_descriptor" :message error}]}
                {:kind "descriptor" :path (str path) :state "current"})

              (= 1 (:version raw))
              (let [result (legacy/descriptor-v1->v2 raw bytes (package-version))]
                (if (seq (:conflicts result))
                  {:kind "descriptor" :path (str path) :state "conflict"
                   :candidate (:candidate result) :conflicts (:conflicts result)}
                  {:kind "descriptor" :path (str path) :state "pending"
                   :source_version 1 :target_version descriptor/version
                   :candidate (:descriptor result)}))

              :else
              {:kind "descriptor" :path (str path) :state "conflict"
               :conflicts [{:code "unsupported_source_version"
                            :message "Project descriptor is neither version 1 nor version 2"}]}))
          (catch Throwable t
            {:kind "descriptor" :path (str path) :state "conflict"
             :conflicts [{:code "unreadable_json" :message (.getMessage t)}]}))))))

(defn- registry-change [home]
  (let [path (registry/path home)]
    (if-not (fs/exists? path)
      {:kind "registry" :path (str path) :state "absent"}
      (try
        (let [raw (store/read-json path)]
          (cond
            (= registry/version (:version raw))
            (if-let [error (registry/validate raw)]
              {:kind "registry" :path (str path) :state "conflict"
               :conflicts [{:code "invalid_v2_registry" :message error}]}
              {:kind "registry" :path (str path) :state "current"})

            (= 1 (:version raw))
            (let [result (legacy/registry-v1->v2 raw)]
              (if (seq (:conflicts result))
                {:kind "registry" :path (str path) :state "conflict" :conflicts (:conflicts result)}
                (if-let [error (registry/validate (:registry result))]
                  {:kind "registry" :path (str path) :state "conflict"
                   :conflicts [{:code "invalid_result" :message error}]}
                  {:kind "registry" :path (str path) :state "pending"
                   :source_version 1 :target_version registry/version
                   :removed_fields (:removed_fields result)
                   :candidate (:registry result)})))

            :else
            {:kind "registry" :path (str path) :state "conflict"
             :conflicts [{:code "unsupported_source_version"
                          :message "Project registry is neither version 1 nor version 2"}]}))
        (catch Throwable t
          {:kind "registry" :path (str path) :state "conflict"
           :conflicts [{:code "unreadable_json" :message (.getMessage t)}]})))))

(defn inspect
  ([options] (inspect options nil))
  ([options project-root]
   (let [workspace-root (or (:workspace-root options) ".")
         root (or (when project-root (fs/normalize (fs/absolutize (fs/path project-root))))
                  (nearest-root workspace-root))
         home (or (:tesseraft-home options)
                  (System/getenv "TESSERAFT_HOME")
                  (str (fs/path (System/getProperty "user.home") ".tesseraft")))
         changes (vec (remove nil? [(descriptor-change root) (registry-change home)]))
         conflicts (vec (mapcat #(or (:conflicts %) []) changes))
         pending (count (filter #(= "pending" (:state %)) changes))]
     {:ok (empty? conflicts)
      :operation "migration.project.inspect"
      :project_root (some-> root str)
      :state (cond (seq conflicts) "conflict" (pos? pending) "pending" :else "current")
      :changes (mapv #(dissoc % :candidate :conflicts) changes)
      :conflicts conflicts
      :applicable pending})))

(defn- migration-plan [options project-root]
  (let [report (inspect options project-root)
        by-path (into {} (map (juxt :path identity) (:changes report)))
        root (:project_root report)
        home (or (:tesseraft-home options)
                 (System/getenv "TESSERAFT_HOME")
                 (str (fs/path (System/getProperty "user.home") ".tesseraft")))]
    ;; Re-read candidates only after inspection so the public report never
    ;; accidentally exposes configuration detail or credential references.
    (assoc report :writes
           (vec (remove nil? [(let [c (descriptor-change root)] (when (= "pending" (:state c)) c))
                              (let [c (registry-change home)] (when (= "pending" (:state c)) c))])))))

(defn migrate!
  ([options mode] (migrate! options mode nil))
  ([options mode project-root]
   (let [plan (migration-plan options project-root)]
     (cond
       (not (contains? #{:dry-run :apply} mode))
       {:ok false :operation "migration.project" :state "error"
        :error {:code "bad_request" :message "Migration mode must be dry-run or apply"}}

       (seq (:conflicts plan))
       (-> plan (assoc :operation "migration.project" :mode (name mode)) (dissoc :writes))

       (= :dry-run mode)
       (-> plan (assoc :operation "migration.project" :mode "dry-run") (dissoc :writes))

       (zero? (:applicable plan))
       (-> plan (assoc :operation "migration.project" :mode "apply" :state "unchanged") (dissoc :writes))

       :else
       (let [writes (:writes plan)
             backups (atom [])]
         (try
           (doseq [{:keys [path candidate kind source_version]} writes]
             (let [backup (str path ".v" source_version ".backup")]
               (safe-write/backup-once! path backup {:owner-only? (= kind "registry")})
               (swap! backups conj {:path path :backup backup :owner-only? (= kind "registry")})
               (safe-write/write-json! path candidate {:owner-only? (= kind "registry")})))
           (let [verified (inspect options project-root)]
             (if (and (:ok verified) (= "current" (:state verified)))
               (-> verified
                   (assoc :operation "migration.project" :mode "apply" :state "migrated"
                          :backups (mapv :backup @backups)))
               (throw (ex-info "Post-migration validation failed" {:verified verified}))))
           (catch Throwable t
             (doseq [{:keys [path backup owner-only?]} (reverse @backups)]
               (try
                 (safe-write/write-text! path (slurp backup) {:owner-only? owner-only?})
                 (catch Throwable _ nil)))
             {:ok false
              :operation "migration.project"
              :mode "apply"
              :state "failed"
              :error {:code (if (= :backup-conflict (:code (ex-data t))) "backup_conflict" "migration_failed")
                      :message (.getMessage t)}})))))))
