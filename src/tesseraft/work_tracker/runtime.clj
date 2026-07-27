(ns tesseraft.work-tracker.runtime
  (:require
    [babashka.fs :as fs]
    [clojure.string :as str]
    [tesseraft.control-plane.core :as cp]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]
    [tesseraft.work-tracker.github-issues :as github-issues]
    [tesseraft.work-tracker.jira :as jira]
    [tesseraft.work-tracker.plane :as plane]))

(defn- control-plane-options [ctx]
  (cond-> {}
    (get-in ctx [:run :workspace-root]) (assoc :workspace-root (get-in ctx [:run :workspace-root]))
    (get-in ctx [:run :tesseraft-home]) (assoc :tesseraft-home (get-in ctx [:run :tesseraft-home]))
    (get-in ctx [:run :runs-root]) (assoc :runs-root (get-in ctx [:run :runs-root]))
    (get-in ctx [:run :workflow-roots]) (assoc :workflow-roots (get-in ctx [:run :workflow-roots]))
    (:credential-resolver ctx) (assoc :credential-resolver (:credential-resolver ctx))))

(defn- persisted-project-context [ctx project-id]
  (let [project (get-in ctx [:run :project-context])
        persisted-id (or (:project_id project) (:project-id project))]
    (when (and (map? project) (= project-id persisted-id)) project)))

(defn- selected-project-and-options [ctx]
  (let [project-id (get-in ctx [:run :project-id])
        base (control-plane-options ctx)
        persisted (persisted-project-context ctx project-id)
        project (or persisted (cp/resolve-project base project-id))]
    (if (:error project)
      {:error {:category "project" :message "Selected project could not be resolved" :details (:error project)}}
      (let [scoped (if persisted
                     (cp/project-context-opts base persisted)
                     (cp/project-scoped-opts base project-id))]
        (if (:error scoped)
          {:error {:category "project" :message "Selected project scope could not be resolved" :details (:error scoped)}}
          {:project project :options scoped})))))

(defn- present-string [v]
  (when (string? v)
    (not-empty (str/trim v))))

(defn- item-id [ctx node]
  (or (present-string (get-in node [:inputs :item-id]))
      (present-string (get-in ctx [:inputs :item-id]))))

(defn- artifact-path [ctx p]
  (let [rendered (spec/render-template-string p ctx)]
    (if (str/starts-with? rendered "/") rendered (str (fs/path (get-in ctx [:run :dir]) rendered)))))

(defn- output-path [ctx node]
  (artifact-path ctx (or (get-in node [:outputs :work-item :path])
                         (get-in node [:outputs :item :path])
                         (get-in node [:outputs :work-item-json :path])
                         "work-tracker/item.json")))

(defn- failure
  ([category message] (failure category message {}))
  ([category message details]
   (merge {:ok false
           :status "error"
           :error_type "work_tracker_fetch_failed"
           :provider "work-tracker"
           :category category
           :message message}
          details)))

(defn- write-result! [ctx path result]
  (store/write-runtime-json! ctx path result)
  path)

(defn fetch-item! [_wf ctx _state-id node]
  (let [out-path (output-path ctx node)
        id (item-id ctx node)]
    (if-not id
      (let [result (failure "missing_item" "work-tracker/fetch-item requires an item-id input")]
        (write-result! ctx out-path result)
        (assoc result :item_file out-path))
      (let [{:keys [project options error]} (selected-project-and-options ctx)]
        (if error
          (let [result (failure (:category error) (:message error) {:details (:details error)})]
            (write-result! ctx out-path result)
            (assoc result :item_file out-path))
          (let [tracker (get-in project [:connections :work-tracker])]
            (cond
              (nil? tracker)
              (let [result (failure "missing_tracker" "Selected project has no work-tracker connection")]
                (write-result! ctx out-path result)
                (assoc result :item_file out-path))

              (not (contains? #{"plane" "jira" "github-issues"} (:provider tracker)))
              (let [result (failure "unsupported_provider" "Unsupported work-tracker fetch provider" {:tracker_provider (:provider tracker)})]
                (write-result! ctx out-path result)
                (assoc result :item_file out-path))

              :else
              (let [credential (cp/resolve-credential options (:credential-ref tracker))
                    provider (:provider tracker)]
                (if-not (and (:present credential) (= "present" (:state credential)) (present-string (:value credential)))
                  (let [result (failure "credential_unresolved" "Work-tracker credential could not be resolved"
                                        {:credential_state (:state credential)})]
                    (write-result! ctx out-path result)
                    (assoc result :item_file out-path))
                  (let [selected-project-id (or (:project_id project) (:project-id project))
                        base-args {:tracker tracker
                                   :tesseraft-project-id selected-project-id
                                   :item-id id
                                   :timeout-ms (or (get-in node [:inputs :timeout-ms])
                                                   (get-in node [:runtime :timeout-ms]))}
                        fetched (case provider
                                  "plane" (plane/fetch-item (assoc base-args :api-key (:value credential)))
                                  "jira" (jira/fetch-item (assoc base-args :token (:value credential)))
                                  "github-issues" (github-issues/fetch-item (assoc base-args :token (:value credential))))]
                    (if (:ok fetched)
                      (let [item (:item fetched)]
                        (write-result! ctx out-path item)
                        {:status "ok"
                         :provider provider
                         :project_id selected-project-id
                         :identifier (:identifier item)
                         :remote_id (get-in item [:remote :id])
                         :item_file out-path})
                      (let [result (assoc fetched :error_type "work_tracker_fetch_failed")]
                        (write-result! ctx out-path result)
                        (assoc result :item_file out-path)))))))))))))

(defn mock-item [ctx node]
  (let [id (or (item-id ctx node) "MOCK-1")
        tracker (get-in ctx [:run :project-context :connections :work-tracker])
        provider (or (present-string (:provider tracker)) "plane")
        remote-scope (case provider
                       "jira" {:project_key (or (get-in tracker [:config :project-key]) "MOCK")}
                       "github-issues" {:repository (or (get-in tracker [:config :repository]) "mock/repo")}
                       {:workspace_slug (or (get-in tracker [:config :workspace-slug]) "mock-workspace")
                        :project_id (or (get-in tracker [:config :project-id]) "mock-plane-project")})]
    {:schema_version 1
     :provider provider
     :project {:id (or (get-in ctx [:run :project-id]) "mock-project")}
     :remote (merge {:id id :identifier id} remote-scope)
     :identifier id
     :title "Mock work item"
     :description "Mock dry-run work item"
     :state {:name "Mock"}
     :priority "none"
     :assignees []
     :labels [{:name "mock"}]
     :url "https://example.invalid/work-tracker/mock"
     :fetched_at (store/now)}))

(defn mock-fetch-item! [_wf ctx _state-id node]
  (let [item (mock-item ctx node)
        out-path (output-path ctx node)]
    (write-result! (assoc ctx :skip-project-credential-redaction? true) out-path item)
    {:status "ok" :mock true :provider (:provider item) :identifier (:identifier item) :item_file out-path}))
