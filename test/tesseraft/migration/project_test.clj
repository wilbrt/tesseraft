(ns tesseraft.migration.project-test
  (:require
    [babashka.fs :as fs]
    [clojure.string :as str]
    [clojure.test :refer [deftest is testing]]
    [tesseraft.control-plane.core :as control-plane]
    [tesseraft.migration.project :as migration]
    [tesseraft.migration.preferences :as preference-migration]
    [tesseraft.runtime.store :as store]))

(defn- temp-context []
  (let [root (fs/create-temp-dir {:prefix "tesseraft-project-migration-"})
        project (fs/path root "project")
        home (fs/path root "home")]
    (fs/create-dirs (fs/path project ".tesseraft"))
    (fs/create-dirs (fs/path home "projects"))
    {:root root :project project :home home
     :options {:workspace-root (str project) :tesseraft-home (str home)}}))

(deftest v1-project-and-registry-migrate-atomically-and-idempotently
  (let [{:keys [root project home options]} (temp-context)
        descriptor (fs/path project ".tesseraft" "project.json")
        registry (fs/path home "projects" "registry.json")]
    (try
      (store/write-json! descriptor
                         {:version 1 :project_id "alpha" :name "Alpha"
                          :runs_root "runs"
                          :discovery {:workflow_roots ["workflows"]}
                          :connections {:github {:credential-ref "env:GH_TOKEN"}}})
      (store/write-json! registry
                         {:version 1 :projects {:alpha {:name "Alpha"
                                                       :workspace_root (str project)
                                                       :runs_root "runs"
                                                       :discovery {:workflow-roots ["workflows"]}
                                                       :source "registration"}}})
      (testing "dry-run is non-mutating and reports both durable changes"
        (let [before-descriptor (slurp (str descriptor))
              before-registry (slurp (str registry))
              report (migration/migrate! options :dry-run (str project))]
          (is (:ok report))
          (is (= "pending" (:state report)))
          (is (= 2 (:applicable report)))
          (is (= before-descriptor (slurp (str descriptor))))
          (is (= before-registry (slurp (str registry))))))
      (testing "apply backs up and installs validated v2 forms"
        (let [report (migration/migrate! options :apply (str project))
              migrated-descriptor (store/read-json descriptor)
              migrated-registry (store/read-json registry)]
          (is (:ok report))
          (is (= "migrated" (:state report)))
          (is (= 2 (:version migrated-descriptor)))
          (is (= "github" (get-in migrated-descriptor [:connections :code-host :provider])))
          (is (= "env:GH_TOKEN" (get-in migrated-descriptor [:connections :code-host :credential-ref])))
          (is (= 2 (:version migrated-registry)))
          (is (= {:workspace_root (str project)} (get-in migrated-registry [:projects :alpha])))
          (is (fs/exists? (str descriptor ".v1.backup")))
          (is (fs/exists? (str registry ".v1.backup")))))
      (testing "a second apply is an unchanged success"
        (let [report (migration/migrate! options :apply (str project))]
          (is (:ok report))
          (is (= "unchanged" (:state report)))
          (is (zero? (:applicable report)))))
      (finally (fs/delete-tree root)))))

(deftest legacy-settings-migrate-without-dropping-secrets
  (let [{:keys [root project home options]} (temp-context)
        settings (fs/path project ".tesseraft" "settings.json")]
    (try
      (store/write-json! settings {:color_scheme "matrix"
                                   :pi_default_provider "openai"
                                   :github_token "MIGRATION_SECRET_SENTINEL"})
      (testing "dry-run exposes fields and paths but never secret values"
        (let [report (preference-migration/migrate! options :dry-run)]
          (is (:ok report))
          (is (= "pending" (:state report)))
          (is (not (str/includes? (pr-str (dissoc report :plan)) "MIGRATION_SECRET_SENTINEL")))))
      (testing "apply stores preferences and credentials separately and clears legacy settings"
        (let [report (preference-migration/migrate! options :apply)]
          (is (:ok report))
          (is (= "migrated" (:state report)))
          (is (= "matrix" (get-in (store/read-json (fs/path home "preferences.json"))
                                   [:preferences :color_scheme])))
          (is (= "MIGRATION_SECRET_SENTINEL"
                 (get-in (store/read-json (fs/path home "credentials.json"))
                         [:credentials :legacy/github-token])))
          (is (= {} (store/read-json settings)))
          (is (fs/exists? (str settings ".v1.backup")))))
      (testing "reapply is idempotent"
        (is (= "unchanged" (:state (preference-migration/migrate! options :apply)))))
      (finally (fs/delete-tree root)))))

(deftest preferences-and-git-identities-are-user-local-versioned-stores
  (let [{:keys [root options home]} (temp-context)]
    (try
      (testing "preference writes never create repository settings"
        (let [result (control-plane/set-settings options
                                                {:color_scheme "matrix"
                                                 :editor_layout "compact"
                                                 :pi_default_provider "openai"}
                                                true nil)]
          (is (= "matrix" (get-in result [:settings :color_scheme])))
          (is (= 1 (:version (store/read-json (fs/path home "preferences.json")))))
          (is (not (fs/exists? (fs/path (:workspace-root options) ".tesseraft" "settings.json"))))))
      (testing "Git identity has an explicit user default and project override"
        (is (= "user-default"
               (get-in (control-plane/set-git-user options "Default User" "default@example.com" true nil)
                       [:git_user :source])))
        (is (= "project-override"
               (get-in (control-plane/set-git-user options "Alpha User" "alpha@example.com" false "alpha")
                       [:git_user :source])))
        (is (= "Default User"
               (get-in (control-plane/get-git-user options "other") [:git_user :name]))))
      (finally (fs/delete-tree root)))))

(deftest unsafe-jira-and-alias-migrations-refuse-to-write
  (let [{:keys [root project options]} (temp-context)
        descriptor (fs/path project ".tesseraft" "project.json")]
    (try
      (store/write-json! descriptor
                         {:version 1 :project_id "alpha"
                          :discovery {:workflow_roots ["a"] :workflow-roots ["b"]}
                          :connections {:jira {:base-url "https://jira.example"
                                               :credential-ref "env:JIRA_TOKEN"}}})
      (let [before (slurp (str descriptor))
            report (migration/migrate! options :apply (str project))]
        (is (false? (:ok report)))
        (is (= "conflict" (:state report)))
        (is (= #{"alias_conflict" "legacy_jira_connection"}
               (set (map :code (:conflicts report)))))
        (is (= before (slurp (str descriptor))))
        (is (not (fs/exists? (str descriptor ".v1.backup")))))
      (finally (fs/delete-tree root)))))
