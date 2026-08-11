(ns tesseraft.handlers.builtin-test
  (:require
    [babashka.fs :as fs]
    [clojure.string :as str]
    [clojure.test :refer [deftest is testing]]
    [tesseraft.adapters.builtin :as builtin]
    [tesseraft.control-plane.core :as control-plane]
    [tesseraft.handlers.github :as github]
    [tesseraft.runtime.store :as store]
    [tesseraft.test-support.connections-doctor :as doctor-fixture]))

(def screenshot-ids
  ["desktop" "desktop-project-menu-open" "desktop-settings" "compact-settings" "mobile-settings"])

(defn- temp-dir [prefix]
  (str (java.nio.file.Files/createTempDirectory
         prefix
         (make-array java.nio.file.attribute.FileAttribute 0))))

(deftest ui-review-evidence-is-machine-enforced
  (let [dir (temp-dir "tesseraft-ui-review-validator")
        screenshot-paths (mapv #(str "manual-testing/screenshots/round-1/" % ".png") screenshot-ids)
        checks (mapv (fn [id] {:id id :passed true :details {}}) builtin/required-ui-checks)
        evidence {:version 1 :mode "executed" :target_url "http://127.0.0.1:1" :worktree_root dir
                  :screenshots (mapv (fn [id path]
                                       {:id id :width 100 :height 100 :path path :state "test"})
                                     screenshot-ids screenshot-paths)
                  :geometry {} :checks checks :findings []}
        status {:status "pass" :summary "passed" :issues_file nil :findings []}
        ctx {:run {:dir dir :id "validator-test" :round 1}}
        node {:inputs {:evidence-file "manual-testing/ui-evidence-1.json"
                       :functional-status-file "manual-testing/status-1.json"
                       :functional-report-file "manual-testing/report-1.md"
                       :visual-status-file "visual-review/status-1.json"
                       :visual-report-file "visual-review/report-1.md"
                       :issues-file "visual-review/validation-issues-1.json"}
              :outputs {:validation {:path "visual-review/validation-1.json"}}}]
    (try
      (doseq [path screenshot-paths]
        (fs/create-dirs (fs/parent (fs/path dir path)))
        (spit (str (fs/path dir path)) "png"))
      (store/write-json! (fs/path dir "manual-testing/ui-evidence-1.json") evidence)
      (store/write-json! (fs/path dir "manual-testing/status-1.json") status)
      (store/write-json! (fs/path dir "visual-review/status-1.json") status)
      (spit (str (fs/path dir "manual-testing/report-1.md")) "Functional checks passed.")
      (fs/create-dirs (fs/path dir "visual-review"))
      (spit (str (fs/path dir "visual-review/report-1.md")) "Visual checks passed.")
      (is (= "pass" (:status (builtin/validate-ui-review! nil ctx :validate node))))
      (spit (str (fs/path dir "manual-testing/report-1.md"))
            "Minor issues (non-blocking): workaround required.")
      (let [rejected (builtin/validate-ui-review! nil ctx :validate node)]
        (is (= "fail" (:status rejected)))
        (is (fs/exists? (fs/path dir "visual-review/validation-issues-1.json"))))
      (finally
        (fs/delete-tree dir)))))

(deftest visual-evidence-is-published-in-the-implementation-branch
  (let [root (temp-dir "tesseraft-ui-evidence-publisher")
        repo (str (fs/path root "repo"))
        run-dir (str (fs/path root "run"))
        screenshot-paths (mapv #(str "manual-testing/screenshots/round-1/" % ".png") screenshot-ids)
        evidence {:screenshots (mapv (fn [id path]
                                       {:id id :width 100 :height 100 :path path :state "test"})
                                     screenshot-ids screenshot-paths)}
        ctx {:run {:dir run-dir :id "publisher-test" :round 1 :worktree-dir repo}
             :inputs {:branch "feature/test"}}
        node {:inputs {:evidence-file "manual-testing/ui-evidence-1.json"
                       :functional-report-file "manual-testing/report-1.md"
                       :visual-report-file "visual-review/report-1.md"}
              :outputs {:published {:path "visual-review/published-1.json"}}}]
    (try
      (fs/create-dirs repo)
      (builtin/shell! {:dir repo} "git" "init" "-b" "feature/test")
      (builtin/shell! {:dir repo} "git" "config" "user.name" "Test User")
      (builtin/shell! {:dir repo} "git" "config" "user.email" "test@example.com")
      (builtin/shell! {:dir repo} "git" "remote" "add" "origin" "git@github.com:example/tesseraft.git")
      (spit (str (fs/path repo "README.md")) "test")
      (builtin/shell! {:dir repo} "git" "add" "README.md")
      (builtin/shell! {:dir repo} "git" "commit" "-m" "Seed")
      (doseq [path screenshot-paths]
        (fs/create-dirs (fs/parent (fs/path run-dir path)))
        (spit (str (fs/path run-dir path)) "png"))
      (store/write-json! (fs/path run-dir "manual-testing/ui-evidence-1.json") evidence)
      (spit (str (fs/path run-dir "manual-testing/report-1.md")) "Functional checks passed.")
      (fs/create-dirs (fs/path run-dir "visual-review"))
      (spit (str (fs/path run-dir "visual-review/report-1.md")) "Visual checks passed.")
      (is (= "ok" (:status (builtin/publish-visual-evidence! nil ctx :publish node))))
      (let [published (store/read-json (fs/path run-dir "visual-review/published-1.json"))
            head (str/trim (builtin/shell! {:dir repo} "git" "rev-parse" "HEAD"))]
        (is (= head (:commit published)))
        (is (str/includes? (:markdown published)
                           (str "raw.githubusercontent.com/example/tesseraft/" head)))
        (is (fs/exists? (fs/path repo "review-evidence/publisher-test/round-1/README.md")))
        (is (fs/exists? (fs/path repo "review-evidence/publisher-test/round-1/functional-report-1.md")))
        (is (fs/exists? (fs/path repo "review-evidence/publisher-test/round-1/visual-report-1.md")))
        (is (str/blank? (builtin/shell! {:dir repo} "git" "status" "--porcelain"))))
      (finally
        (fs/delete-tree root)))))

(deftest connections-doctor-fixture-supports-default-explicit-and-mock-projects
  (let [cwd (temp-dir "doctor-fixture")]
    (try
      (let [fixture (doctor-fixture/seed-project! cwd)
            options {:workspace-root cwd :tesseraft-home (get fixture "tesseraft_home")}
            projects (control-plane/list-projects options)
            ids (set (map #(get % "project_id") (:projects projects)))
            explicit (control-plane/resolve-project options "doctor-explicit")
            mock-server (builtin/mock-test-server {:inputs {:repo-root cwd}
                                                   :run {:dir cwd}}
                                                  {:inputs {:host "127.0.0.1"}})
            mock-projects (control-plane/list-projects options)
            mock-ids (set (map #(get % "project_id") (:projects mock-projects)))]
        (is (= "doctor-explicit" (get fixture "project_id")))
        (is (contains? ids "default"))
        (is (contains? ids "doctor-explicit"))
        (is (= "doctor-explicit" (:project_id explicit)))
        (is (= "github" (get-in explicit [:connections :code-host :provider])))
        (is (= false (:live mock-server)))
        (is (= false (:manual_testing_ready mock-server)))
        (is (nil? (:connections_doctor_fixture mock-server)))
        (is (contains? mock-ids "doctor-explicit")))
      (finally
        (fs/delete-tree cwd)))))

(deftest github-helpers-use-browser-urls-ssh-push-and-scoped-token-env
  (testing "PR URL normalization and SSH remote"
    (let [url github/github-pr-url]
      (is (= "https://github.com/owner/repo/pull/123"
             (url "owner/repo" {:url "https://api.github.com/repos/owner/repo/pulls/123"
                                :number 123})))
      (is (= "https://github.com/owner/repo/pull/123"
             (url "owner/repo" {:url "https://api.github.com/repos/owner/repo/pulls/123"
                                :html_url "https://github.com/owner/repo/pull/123"
                                :number 123})))
      (is (= "https://github.com/owner/repo/pull/124"
             (url "owner/repo" {:url "https://github.com/owner/repo/pull/124" :number 124})))
      (is (= "https://github.com/owner/repo/pull/125" (url "owner/repo" {:number 125})))
      (is (= "git@github.com:owner/repo.git" (github/github-ssh-repo-url "owner/repo")))))
  (testing "token environment"
    (let [ctx {:inputs {:repo-root "/tmp/repo"}}]
      (with-redefs [github/github-token (constantly nil)]
        (is (not (contains? (github/github-command-opts ctx {}) :extra-env))))
      (with-redefs [github/github-token (constantly "test-bot-token")]
        (let [opts (github/github-command-opts ctx {})]
          (is (= #{"GH_TOKEN"} (set (keys (:extra-env opts)))))
          (is (= "test-bot-token" (get-in opts [:extra-env "GH_TOKEN"])))))))
  (testing "create PR pushes through SSH"
    (let [run-dir (temp-dir "tesseraft-create-pr-ssh")
          calls (atom [])
          ctx {:inputs {:branch "test/ssh-push" :base-branch "main"}
               :run {:dir run-dir :worktree-dir run-dir}}
          node {:outputs {:pr-json {:path "pr/pr.json"}}}]
      (try
        (with-redefs [github/github-repo! (fn [_ctx _node] "owner/repo")
                      github/github-existing-pr (fn [_ctx _node _branch]
                                                   {:number 123
                                                    :url "https://github.com/owner/repo/pull/123"
                                                    :state "OPEN"})
                      github/git-user-args (constantly [])
                      github/shell! (fn [_opts & args] (swap! calls conj (vec args)) "")]
          (let [result (github/github-create-pr! nil ctx :create-pr node)]
            (is (= [["git" "push" "git@github.com:owner/repo.git" "test/ssh-push"]] @calls))
            (is (= "ok" (:status result)))
            (is (fs/exists? (fs/path run-dir "pr" "pr.json")))))
        (finally
          (fs/delete-tree run-dir))))))
