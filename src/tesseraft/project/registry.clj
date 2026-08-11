(ns tesseraft.project.registry
  (:require
    [babashka.fs :as fs]
    [clojure.string :as str]
    [tesseraft.persistence.safe-write :as safe-write]
    [tesseraft.project.descriptor :as descriptor]
    [tesseraft.runtime.store :as store]))

(def version 2)

(defn path [tesseraft-home]
  (fs/path tesseraft-home "projects" "registry.json"))

(defn validate [registry]
  (cond
    (not (map? registry)) "project registry must be a JSON object"
    (seq (remove #{:version :projects} (keys registry))) "project registry contains unknown fields"
    (not= version (:version registry)) "unsupported project registry version; run `tesseraft migrate project --dry-run`"
    (not (map? (:projects registry))) "project registry projects must be an object"
    :else
    (some (fn [[id entry]]
            (let [id* (name id)]
              (cond
                (not (descriptor/valid-project-id? id*)) (str "invalid project registry id: " id*)
                (not (map? entry)) (str "invalid project registry entry: " id*)
                (seq (remove #{:workspace_root :last_seen_at} (keys entry)))
                (str "unknown project registry entry field: " id*)
                (not (and (string? (:workspace_root entry)) (not (str/blank? (:workspace_root entry)))))
                (str "invalid project registry workspace_root: " id*)
                (and (contains? entry :last_seen_at) (not (string? (:last_seen_at entry))))
                (str "invalid project registry last_seen_at: " id*)
                :else nil)))
          (:projects registry))))

(defn read! [tesseraft-home]
  (let [registry-path (path tesseraft-home)]
    (if (fs/exists? registry-path)
      (let [registry (store/read-json registry-path)]
        (if-let [error (validate registry)]
          (throw (ex-info error {:code :invalid-project-registry :path (str registry-path)}))
          registry))
      {:version version :projects {}})))

(defn write! [tesseraft-home registry]
  (if-let [error (validate registry)]
    (throw (ex-info error {:code :invalid-project-registry :path (str (path tesseraft-home))}))
    (safe-write/write-json! (path tesseraft-home) registry {:owner-only? true})))

(defn registration [registry project-id]
  (when-let [entry (get-in registry [:projects (keyword project-id)])]
    (assoc entry :project_id project-id :source :registration)))

(defn put [registry project-id workspace-root]
  (assoc-in registry [:projects (keyword project-id)]
            {:workspace_root (str (fs/normalize (fs/path workspace-root)))}))

(defn remove-project [registry project-id]
  (update registry :projects dissoc (keyword project-id)))
