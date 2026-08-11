(ns tesseraft.migration.legacy.project
  "Readers and pure transforms for persisted project forms that normal project
  resolution deliberately does not accept."
  (:require
    [clojure.string :as str]
    [tesseraft.project.descriptor :as descriptor]
    [tesseraft.project.connections :as connections]
    [tesseraft.runtime.store :as store]))

(defn- choose-alias [m canonical legacy field]
  (let [canonical? (contains? m canonical)
        legacy? (contains? m legacy)
        canonical-value (get m canonical)
        legacy-value (get m legacy)]
    (cond
      (and canonical? legacy? (not= canonical-value legacy-value))
      {:conflict {:code "alias_conflict"
                  :field field
                  :message (str "Both aliases for " field " are present with different values")}}
      canonical? {:value canonical-value}
      legacy? {:value legacy-value}
      :else {:value nil})))

(defn descriptor-v1->v2 [raw source-bytes tool-version]
  (let [discovery (if (map? (:discovery raw)) (:discovery raw) {})
        workflow-roots (choose-alias discovery :workflow_roots :workflow-roots "discovery.workflow_roots")
        tesseraft-home (choose-alias discovery :tesseraft_home :tesseraft-home "discovery.tesseraft_home")
        raw-connections (if (map? (:connections raw)) (:connections raw) {})
        jira (or (:jira raw-connections) (get raw-connections "jira"))
        github (or (:github raw-connections) (get raw-connections "github"))
        tracker (or (:work-tracker raw-connections)
                    (:work_tracker raw-connections)
                    (get raw-connections "work-tracker")
                    (get raw-connections "work_tracker"))
        conflicts (vec (remove nil?
                               [(:conflict workflow-roots)
                                (:conflict tesseraft-home)
                                (when (some? (:value tesseraft-home))
                                  {:code "machine_local_field"
                                   :field "discovery.tesseraft_home"
                                   :message "Repository descriptor contains machine-local tesseraft_home; remove it or move it to user configuration"})
                                (when jira
                                  {:code "legacy_jira_connection"
                                   :field "connections.jira"
                                   :message "Jira migration requires an explicit work-tracker project-key and will not guess one"})]))
        code-host (when github
                    {:provider "github"
                     :auth-mode "credential-ref"
                     :credential-ref (or (:credential-ref github) (:credential_ref github))})
        migrated-connections (cond-> {}
                               tracker (assoc :work-tracker tracker)
                               code-host (assoc :code-host code-host))
        migrated (cond-> {:version descriptor/version
                          :project_id (:project_id raw)
                          :name (or (:name raw) (:project_id raw))
                          :runs_root (or (:runs_root raw) "runs")
                          :discovery {:workflow_roots (vec (or (:value workflow-roots) []))}
                          :migration {:source_version 1
                                      :source_sha256 (store/sha256 source-bytes)
                                      :tool_version tool-version}}
                   (seq migrated-connections) (assoc :connections migrated-connections))]
    (cond
      (not= 1 (:version raw))
      {:conflicts [{:code "unsupported_source_version"
                    :field "version"
                    :message "Expected a version 1 project descriptor"}]}

      (connections/contains-raw-secret-key? raw)
      {:conflicts [{:code "raw_secret"
                    :field "connections"
                    :message "Raw secret material cannot be migrated into a project descriptor"}]}

      (seq conflicts) {:conflicts conflicts :candidate migrated}

      :else
      (if-let [error (descriptor/validate migrated)]
        {:conflicts [{:code "invalid_result" :message error}] :candidate migrated}
        {:descriptor migrated :conflicts []}))))

(defn registry-v1->v2 [raw]
  (if-not (and (map? raw) (= 1 (:version raw)) (map? (:projects raw)))
    {:conflicts [{:code "unsupported_registry" :message "Expected a version 1 project registry"}]}
    {:registry {:version 2
                :projects (into {}
                                (map (fn [[id entry]]
                                       [id {:workspace_root (:workspace_root entry)}]))
                                (:projects raw))}
     :removed_fields (vec
                       (mapcat (fn [[id entry]]
                                 (map #(str "projects." (name id) "." (name %))
                                      (remove #{:workspace_root} (keys entry))))
                               (:projects raw)))
     :conflicts []}))
