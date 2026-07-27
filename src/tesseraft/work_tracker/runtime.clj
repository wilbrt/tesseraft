(ns tesseraft.work-tracker.runtime
  (:require
    [babashka.fs :as fs]
    [clojure.string :as str]
    [tesseraft.control-plane.core :as cp]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]
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
      (present-string (get-in node [:inputs :identifier]))
      (present-string (get-in node [:inputs :work-item]))
      (present-string (get-in ctx [:inputs :work-item]))
      (present-string (get-in ctx [:inputs :item-id]))
      (present-string (get-in ctx [:inputs :ticket]))))

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

              (not= "plane" (:provider tracker))
              (let [result (failure "unsupported_provider" "Only Plane work-tracker fetch is supported" {:tracker_provider (:provider tracker)})]
                (write-result! ctx out-path result)
                (assoc result :item_file out-path))

              :else
              (let [credential (cp/resolve-credential options (:credential-ref tracker))]
                (if-not (and (:present credential) (= "present" (:state credential)) (present-string (:value credential)))
                  (let [result (failure "credential_unresolved" "Plane credential could not be resolved"
                                        {:credential_state (:state credential)})]
                    (write-result! ctx out-path result)
                    (assoc result :item_file out-path))
                  (let [fetched (plane/fetch-item {:tracker tracker
                                                   :api-key (:value credential)
                                                   :item-id id
                                                   :timeout-ms (or (get-in node [:inputs :timeout-ms])
                                                                   (get-in node [:runtime :timeout-ms]))})]
                    (if (:ok fetched)
                      (let [item (:item fetched)]
                        (write-result! ctx out-path item)
                        {:status "ok"
                         :provider "plane"
                         :project_id (or (:project_id project) (:project-id project))
                         :identifier (:identifier item)
                         :remote_id (get-in item [:remote :id])
                         :item_file out-path})
                      (let [result (assoc fetched :error_type "work_tracker_fetch_failed")]
                        (write-result! ctx out-path result)
                        (assoc result :item_file out-path))))))))))))

(defn mock-item [ctx node]
  (let [id (or (item-id ctx node) "MOCK-1")]
    {:schema_version 1
     :provider "plane"
     :project {:id "mock-project" :workspace_slug "mock-workspace"}
     :remote {:id id :identifier id}
     :identifier id
     :title "Mock Plane work item"
     :description "Mock dry-run work item"
     :state {:name "Mock"}
     :priority "none"
     :assignees []
     :labels ["mock"]
     :url "https://example.invalid/plane/mock"
     :fetched_at (store/now)}))

(defn mock-fetch-item! [_wf ctx _state-id node]
  (let [item (mock-item ctx node)
        out-path (output-path ctx node)]
    (write-result! ctx out-path item)
    {:status "ok" :mock true :provider "plane" :identifier (:identifier item) :item_file out-path}))
