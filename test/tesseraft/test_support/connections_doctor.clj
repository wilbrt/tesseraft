(ns tesseraft.test-support.connections-doctor
  (:require [babashka.fs :as fs]
            [tesseraft.persistence.safe-write :as safe-write]))

(defn seed-project! [cwd]
  (let [project-id "doctor-explicit"
        home (fs/path cwd ".tesseraft-home")
        registry-path (fs/path home "projects" "registry.json")
        fixture-ws (fs/path cwd ".agent-runs" "manual-connections-doctor-explicit-ws")
        workflows-dir (fs/path fixture-ws ".tesseraft" "workflows" "manual-doctor")
        descriptor-path (fs/path fixture-ws ".tesseraft" "project.json")]
    (fs/create-dirs workflows-dir)
    (fs/create-dirs (fs/path fixture-ws "runs"))
    (safe-write/write-text! (fs/path workflows-dir "workflow.edn")
      "{:api-version \"tesseraft.workflow/v1\" :kind :workflow :metadata {:name \"manual-doctor\"} :initial :start :states {:start {:type :deterministic :handler :noop/succeed :next :done} :done {:type :terminal :status :success}}}\n")
    (safe-write/write-json! descriptor-path
      {:version 2 :project_id project-id :name "Doctor Explicit" :runs_root "runs"
       :discovery {:workflow_roots [".tesseraft/workflows"]}
       :connections {:code-host {:provider "github" :auth-mode "credential-ref" :credential-ref "env:DOCTOR_EXPLICIT_GITHUB_TOKEN"}
                     :work-tracker {:provider "jira" :credential-ref "env:DOCTOR_EXPLICIT_JIRA_TOKEN"
                                    :config {:base-url "https://doctor-explicit.invalid" :project-key "DOC"}}}})
    (safe-write/write-json! registry-path {:version 2 :projects {(keyword project-id) {:workspace_root (str fixture-ws)}}} {:owner-only? true})
    {"project_id" project-id "explicit_manifest" (str descriptor-path)
     "tesseraft_home" (str home) "workspace" (str fixture-ws)}))
