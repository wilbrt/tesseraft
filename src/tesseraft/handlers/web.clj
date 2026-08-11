(ns tesseraft.handlers.web
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [cheshire.core :as json]
            [clojure.string :as str]
            [tesseraft.handlers.common :as common]
            [tesseraft.handlers.git :as git]
            [tesseraft.persistence.safe-write :as safe-write]
            [tesseraft.runtime.store :as store]
            [tesseraft.spec :as spec]))

(def process-opts common/process-opts)
(def shell! common/shell!)
(def artifact-path common/artifact-path)
(def artifact-text common/artifact-text)
(def write-artifact-json! common/write-artifact-json!)
(def repo-dir common/repo-dir)
(def branch-name git/branch-name)
(def absolute-normal-path git/absolute-normal-path)
(def safe-path-component git/safe-path-component)
(def git-user-args git/git-user-args)
(def mock-worktree-dir git/mock-worktree-dir)

(defn java-pid [proc]
  (try
    (.pid proc)
    (catch Throwable _ nil)))

(defn read-line-with-timeout [reader timeout-ms]
  (let [deadline (+ (System/currentTimeMillis) timeout-ms)]
    (loop []
      (cond
        (.ready reader) (.readLine reader)
        (> (System/currentTimeMillis) deadline) nil
        :else (do (Thread/sleep 50) (recur))))))

(defn wait-for-http-ok [url timeout-ms]
  (let [deadline (+ (System/currentTimeMillis) timeout-ms)]
    (loop [last-error nil]
      (if (> (System/currentTimeMillis) deadline)
        (throw (ex-info "Timed out waiting for web service readiness" {:url url :last-error last-error}))
        (let [result (p/shell {:continue true :out :string :err :string}
                              "curl" "-fsS" "--max-time" "2" url)]
          (if (zero? (:exit result))
            true
            (do (Thread/sleep 200) (recur (or (:err result) (:out result))))))))))

(defn wait-for-http-body-contains [url needle timeout-ms]
  (let [deadline (+ (System/currentTimeMillis) timeout-ms)]
    (loop [last-error nil]
      (if (> (System/currentTimeMillis) deadline)
        (throw (ex-info "Timed out waiting for expected web service response"
                        {:url url :needle needle :last-error last-error}))
        (let [result (p/shell {:continue true :out :string :err :string}
                              "curl" "-fsS" "--max-time" "2" url)]
          (if (and (zero? (:exit result)) (str/includes? (str (:out result)) needle))
            true
            (do (Thread/sleep 200)
                (recur (or (:err result) (:out result))))))))))


(defn start-test-server! [_wf ctx _state-id node]
  (let [cwd (absolute-normal-path (repo-dir ctx node))
        host (or (get-in node [:inputs :host]) "127.0.0.1")
        port (str (or (get-in node [:inputs :port]) 0))
        build-command (get-in node [:inputs :build-command] ["npm" "run" "web:build"])
        command (mapv str (or (get-in node [:inputs :command]) ["node" "web/server.js" "--host" host "--port" port]))
        out-path (artifact-path ctx (or (get-in node [:outputs :test-server :path]) "manual-testing/test-server.json"))]
    (when build-command
      (apply shell! {:dir cwd} (map str build-command)))
    (let [;; Default the manual test server to the fake Pi adapter so the
          ;; compose -> preview -> save flow is deterministic without real
          ;; API spend. Respect an explicitly inherited TESSERAFT_PI_ADAPTER
          ;; so real-SDK manual testing remains opt-in via the parent env.
          pi-env (merge {"TESSERAFT_PI_ADAPTER" (or (System/getenv "TESSERAFT_PI_ADAPTER") "fake")}
                        (get-in node [:inputs :env] {}))
          proc (p/process command (process-opts {:dir cwd :out :pipe :err :pipe :extra-env pi-env}))
          java-proc (:proc proc)
          pid (java-pid java-proc)
          stdout-reader (java.io.BufferedReader. (java.io.InputStreamReader. (:out proc)))
          url (loop [lines [] attempts 100]
                (when (zero? attempts)
                  (when java-proc (.destroy java-proc))
                  (throw (ex-info "Timed out waiting for test server URL" {:command command :cwd cwd :stdout lines})))
                (let [line (read-line-with-timeout stdout-reader 1000)
                      lines (cond-> lines line (conj line))
                      match (when line (re-find #"http://127\.0\.0\.1:(\d+)" line))]
                  (if match
                    (str "http://" host ":" (second match))
                    (recur lines (dec attempts)))))
          uri (java.net.URI. url)
          selected-port (Integer/parseInt (str (.getPort uri)))
          artifact {:kind "web-service"
                    :name "test-server"
                    :url url
                    :host host
                    :port selected-port
                    :pid pid
                    :cwd cwd
                    :worktree_root cwd
                    :command command
                    :build_command build-command
                    :started_at (store/now)
                    :lifecycle {:cleanup "kill pid after manual testing/review run"
                                :cleanup_command (when pid (str "kill " pid))
                                :owner "tesseraft deterministic handler :web/start-test-server"}}]
      (wait-for-http-ok url 10000)
      (write-artifact-json! ctx out-path artifact)
      {:status "ok" :test-server-file out-path :url url :pid pid})))

(defn stop-test-server! [_wf ctx _state-id node]
  (let [server-file (artifact-path ctx (get-in node [:inputs :server-file]))
        server (when (fs/exists? server-file) (store/read-json server-file))
        pid (:pid server)
        handle (when (and (integer? pid) (pos? pid))
                 (java.lang.ProcessHandle/of (long pid)))
        present? (and handle (.isPresent handle))
        process-handle (when present? (.get handle))
        requested? (if process-handle (.destroy process-handle) false)
        stopped? (if-not process-handle
                   false
                   (loop [remaining 40]
                     (cond
                       (not (.isAlive process-handle)) true
                       (zero? remaining) (do (.destroyForcibly process-handle) false)
                       :else (do (Thread/sleep 50) (recur (dec remaining))))))]
    {:status "ok"
     :server-file server-file
     :pid pid
     :process-found (boolean present?)
     :stop-requested (boolean requested?)
     :stopped (boolean stopped?)}))

(defn capture-ui-evidence! [wf ctx state-id node]
  (let [script-relative (get-in node [:inputs :script])
        _ (when (str/blank? script-relative)
            (throw (ex-info "UI evidence capture requires an explicit script input" {:state state-id})))
        script (spec/resolve-workflow-path wf script-relative)
        request {:run (:run ctx) :inputs (:inputs ctx) :node (assoc node :id state-id)}
        result (p/shell (process-opts {:dir (repo-dir ctx node)
                                       :in (json/generate-string request)
                                       :out :string :err :string :continue true})
                        "node" script)]
    (when-not (zero? (:exit result))
      (throw (ex-info "UI quality gate process failed"
                      {:script script :exit (:exit result) :out (:out result) :err (:err result)})))
    (try
      (json/parse-string (:out result) true)
      (catch Throwable t
        (throw (ex-info "UI quality gate returned malformed JSON"
                        {:script script :out (:out result) :err (:err result)} t))))))

(def required-ui-checks
  #{"desktop-screenshot" "compact-screenshot" "mobile-screenshot"
    "overlay-open-screenshot" "settings-width-utilization" "console-clean" "primary-task"})

(declare output-path)

(defn ui-validation-issue [severity title details acceptance]
  {:source "ui-review-validator"
   :severity severity
   :title title
   :details details
   :acceptance_criteria acceptance})

(defn read-required-json [ctx relative-path label]
  (let [path (artifact-path ctx relative-path)]
    (when-not (fs/exists? path)
      (throw (ex-info (str label " is missing") {:path path :label label})))
    (store/read-json path)))

(defn report-contradiction [report]
  (when-let [match (some #(re-find % (str/lower-case (or report "")))
                         [#"minor issues?" #"non-blocking" #"workaround"
                          #"clear localstorage" #"developer tools" #"devtools" #"⚠"])]
    (str "Passing report contains unresolved finding language: " match)))

(defn validate-ui-review! [_wf ctx _state-id node]
  (let [evidence (read-required-json ctx (get-in node [:inputs :evidence-file]) "UI evidence")
        functional (read-required-json ctx (get-in node [:inputs :functional-status-file]) "Functional review status")
        visual (read-required-json ctx (get-in node [:inputs :visual-status-file]) "Visual review status")
        functional-report (artifact-text ctx (get-in node [:inputs :functional-report-file]))
        visual-report (artifact-text ctx (get-in node [:inputs :visual-report-file]))
        checks (into {} (map (juxt :id identity) (:checks evidence [])))
        missing-checks (sort (remove #(true? (:passed (get checks %))) required-ui-checks))
        screenshot-problems
        (->> (:screenshots evidence [])
             (keep (fn [{:keys [id path]}]
                     (cond
                       (not (spec/safe-relative-path? path)) (str id " has an unsafe path: " path)
                       (not (fs/exists? (artifact-path ctx path))) (str id " is missing: " path)
                       (zero? (fs/size (artifact-path ctx path))) (str id " is empty: " path))))
             vec)
        screenshot-ids (set (map :id (:screenshots evidence [])))
        missing-screenshots (sort (remove screenshot-ids ["desktop" "desktop-project-menu-open" "desktop-settings" "compact-settings" "mobile-settings"]))
        findings (concat (:findings evidence []) (:findings functional []) (:findings visual []))
        actionable (filter #(or (true? (:actionable %)) (#{"blocker" "major"} (str (:severity %)))) findings)
        contradictions (keep identity [(when (= "pass" (:status functional)) (report-contradiction functional-report))
                                       (when (= "pass" (:status visual)) (report-contradiction visual-report))])
        issues (vec (concat
                      (when (seq missing-checks)
                        [(ui-validation-issue "major" "Required UI checks did not pass"
                           (str "Missing or failing checks: " (str/join ", " missing-checks))
                           "Every required deterministic UI check is present and passing.")])
                      (when (seq missing-screenshots)
                        [(ui-validation-issue "major" "Required visual states were not captured"
                           (str "Missing screenshots: " (str/join ", " missing-screenshots))
                           "Desktop, open-overlay, Settings, compact, and mobile screenshots are all captured.")])
                      (map #(ui-validation-issue "major" "Screenshot artifact is invalid" % "Every declared screenshot exists, is non-empty, and stays inside the run directory.") screenshot-problems)
                      (when (not= "pass" (:status functional))
                        [(ui-validation-issue "major" "Functional browser review did not pass" (:summary functional) "Functional browser review passes with no actionable findings.")])
                      (when (not= "pass" (:status visual))
                        [(ui-validation-issue "major" "Independent visual review did not pass" (:summary visual) "Independent visual review passes with no actionable findings.")])
                      (map #(ui-validation-issue (or (:severity %) "major") (or (:title %) "Actionable UI finding")
                                                 (or (:details %) (pr-str %))
                                                 (or (:acceptance_criteria %) "The actionable UI finding is resolved.")) actionable)
                      (map #(ui-validation-issue "major" "Passing review contradicts its own report" %
                                                 "A passing report contains no unresolved issue, workaround, or non-blocking-finding language.") contradictions)))
        passed? (empty? issues)
        issues-path (artifact-path ctx (get-in node [:inputs :issues-file]))
        validation-path (output-path ctx node :validation "visual-review/validation.json")
        result {:status (if passed? "pass" "fail")
                :summary (if passed? "UI evidence contract validated" "UI evidence contract rejected the review pass")
                :required_checks (sort required-ui-checks)
                :issues_file (when-not passed? (get-in node [:inputs :issues-file]))}]
    (when-not passed? (write-artifact-json! ctx issues-path issues))
    (write-artifact-json! ctx validation-path result)
    result))

(defn github-slug-from-remote [remote]
  (some-> (or (second (re-find #"github\.com[:/]([^\s]+?)(?:\.git)?$" (str/trim remote))) "")
          (str/replace #"\.git$" "")
          not-empty))

(defn publish-visual-evidence! [_wf ctx _state-id node]
  (let [repo (repo-dir ctx node)
        branch (branch-name ctx node)
        run-id (safe-path-component (get-in ctx [:run :id]))
        round (get-in ctx [:run :round])
        destination-relative (str "review-evidence/" run-id "/round-" round)
        destination (fs/path repo destination-relative)
        evidence-relative (get-in node [:inputs :evidence-file])
        evidence (read-required-json ctx evidence-relative "UI evidence")
        functional-report-relative (get-in node [:inputs :functional-report-file])
        visual-report-relative (get-in node [:inputs :visual-report-file])
        file-specs (concat
                     (map (fn [{:keys [path]}] {:source path :destination (fs/file-name path)}) (:screenshots evidence []))
                     [{:source evidence-relative :destination (fs/file-name evidence-relative)}
                      {:source functional-report-relative :destination (str "functional-" (fs/file-name functional-report-relative))}
                      {:source visual-report-relative :destination (str "visual-" (fs/file-name visual-report-relative))}])]
    (fs/create-dirs destination)
    (doseq [file-spec file-specs
            :let [source-relative (:source file-spec)
                  destination-name (:destination file-spec)]]
      (when-not (spec/safe-relative-path? source-relative)
        (throw (ex-info "Visual evidence path is unsafe" {:path source-relative})))
      (let [source (artifact-path ctx source-relative)]
        (when-not (fs/exists? source)
          (throw (ex-info "Visual evidence artifact is missing" {:path source})))
        (fs/copy source (fs/path destination destination-name) {:replace-existing true})))
    (let [remote (str/trim (shell! {:dir repo} "git" "config" "--get" "remote.origin.url"))
          slug (github-slug-from-remote remote)
          screenshots (mapv (fn [{:keys [id path width height state]}]
                              {:id id :file (str (fs/file-name path)) :width width :height height :state state})
                            (:screenshots evidence []))
          readme (str "# UI review evidence\n\n"
                      "Run `" (get-in ctx [:run :id]) "`, round " round ". Generated from the worktree-rooted test server.\n\n"
                      (apply str (for [{:keys [id file width height state]} screenshots]
                                   (str "## " id "\n\n" state " · " width "×" height "\n\n![" id "](" file ")\n\n"))))
          readme-path (fs/path destination "README.md")
          ua (git-user-args ctx)]
      (safe-write/write-text! readme-path readme)
      (apply shell! {:dir repo} "git" (concat ua ["add" destination-relative]))
      (when-not (str/blank? (shell! {:dir repo} "git" "status" "--porcelain" "--" destination-relative))
        (apply shell! {:dir repo} "git" (concat ua ["commit" "-m" (str "Add UI review evidence for " run-id)])))
      (let [commit (str/trim (shell! {:dir repo} "git" "rev-parse" "HEAD"))
            readme-url (when slug (str "https://github.com/" slug "/blob/" commit "/" destination-relative "/README.md"))
            markdown (str "## Visual evidence\n\n"
                          (when readme-url (str "[Open the complete screenshot set](" readme-url ")\n\n"))
                          (apply str (for [{:keys [id file]} screenshots]
                                       (if slug
                                         (str "### " id "\n\n![" id "](https://raw.githubusercontent.com/" slug "/" commit "/" destination-relative "/" file ")\n\n")
                                         (str "- " id ": `" destination-relative "/" file "`\n")))))
            published {:status "ok" :repository slug :branch branch
                       :commit commit
                       :directory destination-relative :readme_url readme-url
                       :markdown markdown :screenshots screenshots}
            published-path (output-path ctx node :published "visual-review/published.json")]
        (write-artifact-json! ctx published-path published)
        {:status "ok" :published_file published-path :evidence_directory destination-relative}))))

(defn output-path [ctx node output-key fallback]
  (artifact-path ctx (or (get-in node [:outputs output-key :path]) fallback)))

(defn mock-test-server [ctx node]
  (let [cwd (absolute-normal-path (repo-dir ctx node))]
    {:kind "web-service"
     :name "mock-test-server"
     :url "http://127.0.0.1:0"
     :host (or (get-in node [:inputs :host]) "127.0.0.1")
     :port 0
     :pid nil
     :cwd cwd
     :worktree_root cwd
     :command (mapv str (or (get-in node [:inputs :command]) []))
     :build_command (when-let [cmd (get-in node [:inputs :build-command])] (mapv str cmd))
     :mock true
     :live false
     :manual_testing_ready false
     :manual_testing_note "Mock dry run did not start a live HTTP server. Use a non-mock :web/start-test-server run for browser/API manual review."
     :started_at (store/now)
     :lifecycle {:cleanup "none; mock dry run did not start a process"}}))

(defn mock-start-test-server! [_wf ctx _state-id node]
  (let [server (mock-test-server ctx node)
          out-path (output-path ctx node :test-server "manual-testing/test-server.json")]
    (write-artifact-json! ctx out-path server)
    {:status "ok" :mock true :live false :manual-testing-ready false
     :test-server-file out-path :url (:url server) :pid nil}))

(defn mock-stop-test-server! [_wf _ctx _state-id _node]
  {:status "ok" :mock true :process-found false :stop-requested false})

(defn mock-capture-ui-evidence! [_wf ctx _state-id node]
  (let [evidence {:version 1 :mode "executed" :target_url "http://127.0.0.1:0"
                    :worktree_root (mock-worktree-dir ctx node) :screenshots [] :geometry {}
                    :checks (mapv (fn [id] {:id id :passed true :details {:mock true}}) required-ui-checks)
                    :findings [] :mock true}
          out-path (output-path ctx node :evidence "manual-testing/ui-evidence.json")]
    (write-artifact-json! ctx out-path evidence)
    {:status "pass" :mock true :evidence_file out-path :issues_file nil}))

(defn mock-validate-ui-review! [_wf ctx _state-id node]
  (let [validation {:status "pass" :summary "Mock UI evidence contract validated" :issues_file nil}
          out-path (output-path ctx node :validation "visual-review/validation.json")]
    (write-artifact-json! ctx out-path validation)
    validation))

(defn mock-publish-visual-evidence! [_wf ctx _state-id node]
  (let [published {:status "ok" :mock true :directory "review-evidence/mock" :markdown "## Visual evidence\n\nMock evidence.\n"}
          out-path (output-path ctx node :published "visual-review/published.json")]
    (write-artifact-json! ctx out-path published)
    {:status "ok" :mock true :published_file out-path}))
