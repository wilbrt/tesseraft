(ns tesseraft.control-plane.operations
  (:require
    [babashka.fs :as fs]
    [clojure.string :as str]
    [tesseraft.control-plane.core :as core]
    [tesseraft.control-plane.workflows :as workflows]
    [tesseraft.credentials.store :as credentials]
    [tesseraft.identity.git :as git-identity]
    [tesseraft.runtime.core :as runtime]
    [tesseraft.runtime.operations :as runtime-operations]
    [tesseraft.spec :as spec]))

(defn- normalize-project-spec [payload]
  (cond-> payload
    (get payload :workflow_roots) (assoc :discovery {:workflow-roots (:workflow_roots payload)})
    (get-in payload [:discovery :workflow_roots])
    (assoc-in [:discovery :workflow-roots] (get-in payload [:discovery :workflow_roots]))))

(defn- project-root [options project-id]
  (let [project (core/resolve-project options project-id)]
    (if (:error project) project (:workspace_root project))))

(defn- read-workflow-package [options project-id name]
  (let [root (project-root options project-id)]
    (if (map? root)
      root
      (let [install-root (System/getenv "TESSERAFT_INSTALL_ROOT")
            candidates (cond-> [(fs/path root ".tesseraft" "workflows" name "workflow.edn")
                                (fs/path root "examples" "tutorials" name "workflow.edn")
                                (fs/path root "examples" "catalog" name "workflow.edn")]
                         (not (str/blank? install-root))
                         (conj (fs/path install-root "examples" "tutorials" name "workflow.edn")
                               (fs/path install-root "examples" "catalog" name "workflow.edn")))
            file (first (filter fs/exists? candidates))]
        (if-not file
          (core/error-response 404 "not_found" "Workflow package not found" {:name name})
          (try
            {:workflow {:name name :path (str file)
                        :normalized (core/api-value (dissoc (spec/read-workflow file) :__file :__dir))}}
            (catch Throwable t
              (core/error-response 422 "parse_error" "Workflow package could not be read" {:message (.getMessage t)}))))))))

(defn- run-start [options project-id payload]
  (let [project (core/resolve-project options project-id)]
    (if (:error project)
      project
      (let [pid (:project_id project)
            scoped (core/project-scoped-opts options pid)
            workflow (core/resolve-workflow (if (:error scoped) options scoped) (:workflow_name payload))
            run-id (:run_id payload)
            inputs (or (:inputs payload) {})
            existing (when (string? run-id) (core/resolve-run options run-id pid))
            git-user (git-identity/resolve-identity
                       (git-identity/read! (core/tesseraft-home options)) pid)
            max-steps (:max_steps payload)]
        (cond
          (:error scoped) scoped
          (:error workflow) workflow
          (not (and (string? run-id) (re-matches #"^[A-Za-z0-9._-]+$" run-id)))
          (core/error-response 400 "bad_request" "run_id is required and may contain only letters, numbers, dot, underscore, and dash")
          (not (and (map? inputs) (every? string? (vals inputs))))
          (core/error-response 400 "bad_request" "inputs must be an object of string values")
          (and existing (not (:error existing)))
          (core/error-response 409 "conflict" "Run id already exists" {:run_id run-id})
          (and max-steps (not (and (integer? max-steps) (<= 1 max-steps 1000))))
          (core/error-response 400 "bad_request" "max_steps must be an integer from 1 to 1000")
          :else
          (let [ctx (runtime/start! (str (:file workflow))
                                    (cond-> (merge scoped
                                                   {:run-id (:run_id payload)
                                                    :inputs inputs
                                                    :project-id pid
                                                    :project-context project})
                                      (and (:name git-user) (:email git-user)) (assoc :git-user git-user)))]
            {:run (:run ctx) :max_steps (or max-steps 100)}))))))

(defn- resolve-run-dir [options project-id run-id]
  (let [resolved (core/resolve-run options run-id project-id)]
    (if (:error resolved) resolved {:run_dir (str (:run-dir resolved))})))

(defn- apply-runtime-operation [options project-id operation payload]
  (let [target (resolve-run-dir options project-id (:run_id payload))]
    (if (:error target)
      target
      (let [author (when (= operation "run.decide")
                     (or (:author payload)
                         (git-identity/resolve-identity
                           (git-identity/read! (core/tesseraft-home options)) project-id)))
            request {:operation operation
                     :payload (cond-> (merge payload target)
                                author (assoc :author author))}
            result (runtime-operations/apply-operation request)]
        (if (:error result) result (:result result))))))

(defn- prepare-run-resume [options project-id payload]
  (let [target (resolve-run-dir options project-id (:run_id payload))
        max-steps (or (:max_steps payload) 100)]
    (cond
      (:error target) target
      (not (and (integer? max-steps) (<= 1 max-steps 1000)))
      (core/error-response 400 "bad_request" "max_steps must be an integer from 1 to 1000")
      :else (assoc target :max_steps max-steps))))

(defn apply-operation [options request]
  (let [operation (or (:operation request) (get request "operation"))
        project-id (or (:project_id request) (:project-id request))
        payload (or (:payload request) {})
        result
        (case operation
          "project.create" (core/create-project options project-id (normalize-project-spec payload))
          "project.update" (core/update-project options project-id (normalize-project-spec payload))
          "project.delete" (core/unregister-project options project-id)
          "project.register" (let [root (:project_root payload)
                                   descriptor (core/read-project-descriptor (assoc options :project-root root))]
                               (if (:error descriptor)
                                 descriptor
                                 (core/create-project options (:project_id descriptor)
                                                      {:workspace_root (:workspace_root descriptor)
                                                       :source "registration"})))
          "project.connections.update" (core/update-project-connections options project-id (:connections payload))
          "preferences.update" (core/set-settings options (:preferences payload) true project-id)
          "git-identity.update" (core/set-git-user options (:name payload) (:email payload)
                                                    (not= "project" (:scope payload)) project-id)
          "credential.put" (credentials/put! options (:path payload) (:value payload))
          "credential.delete" (credentials/delete! options (:path payload))
          "workflow.save" (let [root (project-root options project-id)]
                             (if (map? root)
                               root
                               (workflows/save! {:project-root root :name (:name payload)
                                                 :workflow (:workflow payload)})))
          "workflow.validate" (let [root (project-root options project-id)]
                                (if (map? root) root
                                  (workflows/validate {:project-root root :name (:name payload)
                                                       :workflow (:workflow payload)})))
          "workflow.read-package" (read-workflow-package options project-id (:name payload))
          "run.start" (run-start options project-id payload)
          "run.step" (apply-runtime-operation options project-id "run.step" payload)
          "run.cancel" (apply-runtime-operation options project-id "run.cancel" payload)
          "run.decide" (apply-runtime-operation options project-id "run.decide" payload)
          "run.resume.prepare" (prepare-run-resume options project-id payload)
          "run.delete" (core/delete-run options (:run_id payload) project-id)
          "run.comment.add" (core/add-run-comment options (:run_id payload)
                                                   {:path (:path payload)
                                                    :body (:body payload)
                                                    :anchor (:anchor payload)
                                                    :author (:author payload)}
                                                   project-id)
          (core/error-response 400 "unknown_operation" (str "Unknown control-plane operation: " operation)))]
    (if (:error result)
      result
      {:ok true :operation operation :result (dissoc result :status)})))
