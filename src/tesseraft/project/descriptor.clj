(ns tesseraft.project.descriptor
  (:require
    [babashka.fs :as fs]
    [tesseraft.project.connections :as connections]
    [tesseraft.runtime.store :as store]))

(def version 2)
(def project-id-re #"^[a-z0-9][a-z0-9-]{0,62}$")

(defn path [project-root]
  (fs/path project-root ".tesseraft" "project.json"))

(defn valid-project-id? [value]
  (and (string? value) (re-matches project-id-re value)))

(defn validate [raw]
  (cond
    (not (map? raw)) "project descriptor must be a JSON object"
    (not= version (:version raw)) "unsupported project descriptor version; run `tesseraft migrate project --dry-run`"
    (not (valid-project-id? (:project_id raw))) "invalid project descriptor project_id"
    (some #(not (contains? #{:version :project_id :name :runs_root :discovery :connections :runtime_defaults :migration} %)) (keys raw))
    "project descriptor contains unknown fields"
    (and (contains? raw :name) (not (string? (:name raw)))) "project descriptor name must be a string"
    (and (contains? raw :runs_root) (not (string? (:runs_root raw)))) "project descriptor runs_root must be a string"
    (and (contains? raw :runtime_defaults) (not (map? (:runtime_defaults raw)))) "project descriptor runtime_defaults must be an object"
    (and (map? (:runtime_defaults raw))
         (some #(not (contains? #{:default_executor :executor_mode} %)) (keys (:runtime_defaults raw))))
    "project descriptor runtime_defaults contains unknown fields"
    (and (get-in raw [:runtime_defaults :default_executor])
         (not (string? (get-in raw [:runtime_defaults :default_executor]))))
    "project descriptor runtime_defaults.default_executor must be a string"
    (and (get-in raw [:runtime_defaults :executor_mode])
         (not (contains? #{"live" "mock"} (get-in raw [:runtime_defaults :executor_mode]))))
    "project descriptor runtime_defaults.executor_mode must be live or mock"
    :else
    (let [discovery (:discovery raw)
          migration (:migration raw)]
      (cond
        (and (some? discovery) (not (map? discovery))) "project descriptor discovery must be an object"
        (and (map? discovery) (some #(not= :workflow_roots %) (keys discovery)))
        "project descriptor discovery contains unknown fields"
        (and (contains? discovery :workflow_roots)
             (or (not (vector? (:workflow_roots discovery)))
                 (not-every? string? (:workflow_roots discovery))))
        "project descriptor discovery.workflow_roots must be an array of strings"
        (and (some? migration) (not (map? migration))) "project descriptor migration must be an object"
        (and (map? migration)
             (some #(not (contains? #{:source_version :source_sha256 :tool_version} %)) (keys migration)))
        "project descriptor migration contains unknown fields"
        (and (contains? migration :source_version) (not (integer? (:source_version migration))))
        "project descriptor migration.source_version must be an integer"
        (and (contains? migration :source_sha256) (not (string? (:source_sha256 migration))))
        "project descriptor migration.source_sha256 must be a string"
        (and (contains? migration :tool_version) (not (string? (:tool_version migration))))
        "project descriptor migration.tool_version must be a string"
        :else (connections/validate-connections (:connections raw) "project descriptor")))))

(defn write-shape [project-id project]
  (cond-> {:version version
           :project_id project-id
           :name (or (:name project) project-id)
           :runs_root (or (:runs_root project) "runs")
           :discovery {:workflow_roots (vec (or (get-in project [:discovery :workflow-roots])
                                                (get-in project [:discovery :workflow_roots])
                                                []))}}
    (seq (:connections project)) (assoc :connections (connections/normalize-connections (:connections project)))
    (seq (:runtime_defaults project)) (assoc :runtime_defaults (:runtime_defaults project))
    (seq (:migration project)) (assoc :migration (:migration project))))

(defn normalize [project-root raw]
  (-> raw
      (assoc :workspace_root (str (fs/normalize (fs/path project-root))))
      (update :runs_root #(or % "runs"))
      (assoc :discovery {:workflow-roots (vec (or (get-in raw [:discovery :workflow_roots]) []))})
      (assoc :connections (connections/normalize-connections (:connections raw)))))

(defn read-at-root [project-root]
  (let [descriptor-path (path project-root)]
    (when (fs/exists? descriptor-path)
      (let [raw (store/read-json descriptor-path)]
        (if-let [error (validate raw)]
          {:error error :path (str descriptor-path) :raw raw}
          {:descriptor (normalize project-root raw) :path (str descriptor-path)})))))
