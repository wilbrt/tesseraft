(ns tesseraft.adapters.builtin
  (:require
    [tesseraft.spec :as spec]
    [tesseraft.runtime.store :as store]
    [tesseraft.control-plane.core :as cp]
    [babashka.fs :as fs]
    [babashka.process :as p]
    [cheshire.core :as json]
    [clojure.string :as str]))

(def ^:dynamic *process-extra-env* {})

(defn- process-opts [opts]
  (update opts :extra-env #(merge *process-extra-env* %)))

(defn shell! [opts & args]
  (let [r (apply p/shell (process-opts (merge {:out :string :err :string :continue true} opts)) args)]
    (when-not (zero? (:exit r))
      (throw (ex-info "Command failed" {:args args :exit (:exit r) :out (:out r) :err (:err r)})))
    (:out r)))
(defn run-dir [ctx] (get-in ctx [:run :dir]))
(defn artifact-path [ctx p]
  (let [rendered (spec/render-template-string p ctx)]
    (str (fs/path (run-dir ctx) rendered))))
(defn write-artifact-json! [ctx p data]
  (store/write-runtime-json! ctx p data))
(defn artifact-text [ctx p]
  (when p
    (let [path (artifact-path ctx p)]
      (when (fs/exists? path)
        (str/trim (slurp path))))))
(defn rendered-runtime-cwd [ctx node]
  (some-> (get-in node [:runtime :cwd]) (spec/render-template-string ctx) not-empty))
(defn repo-dir
  ([ctx] (or (get-in ctx [:run :worktree-dir]) (get-in ctx [:inputs :repo-root]) (get-in ctx [:inputs :repo]) "."))
  ([ctx node]
   (or (rendered-runtime-cwd ctx node)
       (artifact-text ctx (get-in node [:inputs :repo-dir-file]))
       (get-in ctx [:run :worktree-dir])
       (get-in ctx [:inputs :repo-root])
       (get-in ctx [:inputs :repo])
       ".")))
(defn render-command [ctx command-template] (spec/render-template-string command-template ctx))
(defn branch-name [ctx node]
  (or (not-empty (get-in ctx [:inputs :branch]))
      (not-empty (artifact-text ctx (get-in node [:inputs :branch-file])))
      (str "feature/" (str/lower-case (get-in ctx [:inputs :ticket] "workflow")))))
(defn git-ref-candidates [ref]
  (cond
    (str/starts-with? ref "refs/") [ref]
    (str/starts-with? ref "origin/") [(str "refs/remotes/" ref)]
    :else [(str "refs/heads/" ref)]))

(defn git-ref-exists? [repo ref]
  (boolean
    (some #(zero? (:exit (p/shell {:dir repo :continue true :out :string :err :string}
                                  "git" "show-ref" "--verify" "--quiet" %)))
          (git-ref-candidates ref))))
(defn base-ref [ctx base]
  (let [repo (repo-dir ctx)
        remote-ref (str "origin/" base)]
    (cond
      (git-ref-exists? repo remote-ref) remote-ref
      (git-ref-exists? repo base) base
      :else remote-ref)))

;; Git user identity overrides.
;; Reads the configured git user from the project-local
;; .tesseraft/git-user.json (or global ~/.tesseraft/git-user.json when the
;; project file is absent). Returns a vector of `git -c` override args that
;; handlers thread into mutating git invocations, so attribution is explicit
;; without polluting the repo's persistent git config. Returns [] when no user
;; is configured, preserving the previous ambient-git-config behavior.
(defn git-user-config []
  (let [home (or (System/getenv "TESSERAFT_HOME")
                 (str (fs/path (System/getProperty "user.home") ".tesseraft")))
        project-path (fs/path "." ".tesseraft" "git-user.json")
        global-path (fs/path home "git-user.json")
        read-file (fn [p] (when (fs/exists? p)
                            (try (store/read-json p) (catch Throwable _ nil))))]
    (or (read-file project-path) (read-file global-path))))

(defn git-user-args []
  (let [user (not-empty (git-user-config))]
    (if-not (and (map? user) (:name user) (:email user))
      []
      ["-c" (str "user.name=" (:name user))
       "-c" (str "user.email=" (:email user))])))

(defn jira-fetch-ticket! [_wf ctx _state-id node]
  (let [ticket (get-in ctx [:inputs :ticket])
        command (or (System/getenv "JIRA_FETCH_CMD") "acli jira workitem view {{inputs.ticket}} --json")
        raw (shell! {:dir (repo-dir ctx)} "bash" "-lc" (render-command ctx command))
        out-path (artifact-path ctx (or (get-in node [:outputs :ticket-json :path]) "ticket.json"))]
    (store/write-runtime-text! ctx out-path raw)
    {:status "ok" :ticket ticket :ticket-file out-path}))

(defn git-ensure-branch! [_wf ctx _state-id node]
  (let [branch (branch-name ctx node)
        base (or (get-in ctx [:inputs :base-branch]) (get-in ctx [:workflow :defaults :base-branch]) "main")
        repo (repo-dir ctx node)
        ua (git-user-args)]
    (apply shell! {:dir repo} "git" (concat ua ["fetch" "origin"]))
    (let [exists? (git-ref-exists? repo branch)
          start-point (base-ref (assoc-in ctx [:inputs :repo-root] repo) base)]
      (if exists?
        (apply shell! {:dir repo} "git" (concat ua ["checkout" branch]))
        (apply shell! {:dir repo} "git" (concat ua ["checkout" "-b" branch start-point])))
      {:status "ok" :branch branch :base-branch base :start-point start-point})))

(defn safe-path-component [s]
  (let [component (-> (str s)
                      (str/replace #"[^A-Za-z0-9._-]+" "-")
                      (str/replace #"^-+|-+$" ""))]
    (if (str/blank? component) "branch" component)))

(defn absolute-normal-path [p]
  (str (.normalize (.toAbsolutePath (java.nio.file.Paths/get (str p) (into-array String []))))))

(defn inside-dir? [parent child]
  (let [parent-path (.normalize (.toAbsolutePath (java.nio.file.Paths/get (str parent) (into-array String []))))
        child-path (.normalize (.toAbsolutePath (java.nio.file.Paths/get (str child) (into-array String []))))]
    (.startsWith child-path parent-path)))

(defn worktree-dir [ctx node branch]
  (let [repo (repo-dir ctx node)
        configured (get-in node [:inputs :worktree-dir])]
    (if configured
      (do
        (when-not (spec/safe-relative-path? configured)
          (throw (ex-info "Worktree dir override must be a safe relative path" {:worktree-dir configured})))
        (let [p (fs/path repo configured)]
          (when-not (inside-dir? repo p)
            (throw (ex-info "Worktree dir must stay inside the repo root" {:worktree-dir configured})))
          (absolute-normal-path p)))
      (absolute-normal-path (fs/path repo ".agent-worktrees" (str (get-in ctx [:workflow :name]) "-" (get-in ctx [:run :id]) "-" (safe-path-component branch)))))))

(defn current-worktree-branch [path]
  (str/trim (shell! {:dir path} "git" "rev-parse" "--abbrev-ref" "HEAD")))

(defn git-worktree? [path]
  (zero? (:exit (p/shell {:dir path :continue true :out :string :err :string}
                         "git" "rev-parse" "--is-inside-work-tree"))))

(defn worktree-path-for-branch [repo branch]
  (let [raw (shell! {:dir repo} "git" "worktree" "list" "--porcelain")]
    (loop [lines (str/split-lines raw) path nil]
      (when-let [line (first lines)]
        (cond
          (str/starts-with? line "worktree ")
          (recur (rest lines) (subs line (count "worktree ")))

          (= line (str "branch refs/heads/" branch))
          path

          :else
          (recur (rest lines) path))))))

(defn ensure-worktree-path! [repo branch path start-point]
  (if (fs/exists? path)
    (do
      (when-not (git-worktree? path)
        (throw (ex-info "Worktree path exists but is not a Git worktree" {:path path})))
      (let [actual (current-worktree-branch path)]
        (when-not (= branch actual)
          (throw (ex-info "Worktree path is checked out on a different branch" {:path path :expected branch :actual actual})))))
    (if (git-ref-exists? repo branch)
      (if-let [existing (worktree-path-for-branch repo branch)]
        (throw (ex-info "Branch is already checked out in another worktree" {:branch branch :existing-worktree existing :expected-worktree path}))
        (shell! {:dir repo} "git" "worktree" "add" path branch))
      (shell! {:dir repo} "git" "worktree" "add" "-b" branch path start-point))))

(defn git-ensure-worktree! [_wf ctx _state-id node]
  (let [branch (branch-name ctx node)
        _ (when (str/blank? branch) (throw (ex-info "Branch name is blank" {})))
        base (or (get-in ctx [:inputs :base-branch]) (get-in ctx [:workflow :defaults :base-branch]) "main")
        repo (repo-dir ctx node)
        path (worktree-dir ctx node branch)
        out-path (artifact-path ctx (or (get-in node [:outputs :worktree-path :path])
                                        (get-in node [:inputs :path-output])
                                        "worktree/path.txt"))
        ua (git-user-args)]
    (apply shell! {:dir repo} "git" (concat ua ["fetch" "origin"]))
    (let [start-point (base-ref (assoc-in ctx [:inputs :repo-root] repo) base)]
      (fs/create-dirs (fs/parent path))
      (ensure-worktree-path! repo branch path start-point)
      ;; Apply the configured git identity to the worktree via `git config --local`
      ;; so commits made by agent nodes inside the worktree are attributed to the
      ;; configured user. Worktrees share the repo's .git/config, so this is a
      ;; local single-user workspace affordance (see docs/design). Never writes
      ;; global git config.
      (when (seq ua)
        (let [user (git-user-config)]
          (shell! {:dir path} "git" "config" "--local" "user.name" (:name user))
          (shell! {:dir path} "git" "config" "--local" "user.email" (:email user))))
      (fs/create-dirs (fs/parent out-path))
      (spit out-path path)
      {:status "ok" :branch branch :base-branch base :start-point start-point :worktree-dir path :worktree-file out-path})))

(defn git-push! [_wf ctx _state-id node]
  (let [branch (branch-name ctx node)
        ua (git-user-args)]
    (apply shell! {:dir (repo-dir ctx node)} "git" (concat ua ["push" "origin" branch]))
    {:status "ok" :branch branch}))

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

(defn github-token
  ([] (github-token {} nil))
  ([ctx project]
   (let [project-id (or (get-in ctx [:run :project-id]) (:project_id project) (:project-id project))
         base-options (control-plane-options ctx)
         persisted (persisted-project-context ctx project-id)
         options (cond
                   persisted (cp/project-context-opts base-options persisted)
                   project-id (cp/project-scoped-opts base-options project-id)
                   :else base-options)
         ref (get-in project [:connections :github :credential-ref])
         token (:value (cp/resolve-credential (if (:error options) base-options options) ref))]
     (when-not (str/blank? token) token))))

(defn github-command-opts [ctx node]
  (let [project-id (get-in ctx [:run :project-id])
        options (control-plane-options ctx)
        project (or (persisted-project-context ctx project-id)
                    (cp/resolve-project options project-id))
        token (when-not (:error project) (github-token ctx project))]
    (cond-> {:dir (repo-dir ctx node)}
      token (assoc :extra-env {"GH_TOKEN" token}))))

(defn github-repo! [ctx node]
  (str/trim (shell! (github-command-opts ctx node) "gh" "repo" "view" "--json" "nameWithOwner" "--jq" ".nameWithOwner")))

(defn non-empty-string [v]
  (when (string? v)
    (not-empty (str/trim v))))

(defn parse-uri [s]
  (try
    (java.net.URI. s)
    (catch Exception _ nil)))

(defn uri-path-segments [uri]
  (->> (str/split (or (.getPath uri) "") #"/")
       (remove str/blank?)
       vec))

(defn integer-string? [s]
  (try
    (Long/parseLong s)
    true
    (catch Exception _ false)))

(defn github-api-pr-url->browser-url [url]
  (when-let [uri (parse-uri url)]
    (let [segments (uri-path-segments uri)]
      (when (and (= "https" (.getScheme uri))
                 (= "api.github.com" (.getHost uri))
                 (= 5 (count segments))
                 (= "repos" (segments 0))
                 (= "pulls" (segments 3))
                 (integer-string? (segments 4)))
        (str "https://github.com/" (segments 1) "/" (segments 2) "/pull/" (segments 4))))))

(defn github-browser-pr-url? [url]
  (when-let [uri (parse-uri url)]
    (let [segments (uri-path-segments uri)]
      (and (= "https" (.getScheme uri))
           (= "github.com" (.getHost uri))
           (= 4 (count segments))
           (= "pull" (segments 2))
           (integer-string? (segments 3))))))

(defn github-pr-url [repo pr]
  (let [html-url (non-empty-string (:html_url pr))
        url (non-empty-string (:url pr))
        number (:number pr)]
    (cond
      html-url html-url
      (and url (github-browser-pr-url? url)) url
      url (or (github-api-pr-url->browser-url url) url)
      (and (not-empty repo) number) (str "https://github.com/" repo "/pull/" number))))

(defn github-existing-pr [ctx node branch]
  (let [r (p/shell (merge (github-command-opts ctx node) {:out :string :err :string :continue true})
                   "gh" "pr" "view" branch "--json" "number,url,state,headRefName,baseRefName")]
    (when (zero? (:exit r)) (json/parse-string (:out r) true))))

(defn github-ssh-repo-url [repo]
  (str "git@github.com:" repo ".git"))

(defn github-create-pr! [_wf ctx _state-id node]
  (let [repo (github-repo! ctx node)
        branch (branch-name ctx node)
        base (or (get-in ctx [:inputs :base-branch]) "main")
        title-file (artifact-path ctx (or (get-in node [:inputs :title-file]) "pr/pr-title.txt"))
        body-file (artifact-path ctx (or (get-in node [:inputs :body-file]) "pr/pr-body.md"))
        pr-file (artifact-path ctx (or (get-in node [:outputs :pr-json :path]) "pr/pr.json"))
        ua (git-user-args)
        _ (apply shell! {:dir (repo-dir ctx node)} "git" (concat ua ["push" (github-ssh-repo-url repo) branch]))
        pr (or (github-existing-pr ctx node branch)
               (let [payload-file (artifact-path ctx "pr/create-payload.json")]
                 (write-artifact-json! ctx payload-file {:title (str/trim (slurp title-file))
                                                          :body (slurp body-file)
                                                          :head branch :base base :draft false})
                 (json/parse-string (shell! (github-command-opts ctx node) "gh" "api" "--method" "POST"
                                            (str "repos/" repo "/pulls") "--input" payload-file) true)))
        normalized (cond-> {:number (:number pr) :url (github-pr-url repo pr) :state (:state pr)
                            :headRefName (or (:headRefName pr) branch) :baseRefName (or (:baseRefName pr) base)}
                     (some-> (:url pr) non-empty-string github-api-pr-url->browser-url)
                     (assoc :api_url (non-empty-string (:url pr))))]
    (write-artifact-json! ctx pr-file normalized)
    {:status "ok" :pr normalized :pr-file pr-file}))

(defn gh-api-all [ctx node endpoint]
  (let [raw (shell! (github-command-opts ctx node) "gh" "api" "--paginate" "--slurp" endpoint)
        pages (json/parse-string raw true)]
    (->> pages (mapcat #(if (sequential? %) % [%])) vec)))
(defn github-fetch-pr-feedback! [_wf ctx _state-id node]
  (let [repo (github-repo! ctx node)
        pr-path (artifact-path ctx (or (get-in node [:inputs :pr-json]) "pr/pr.json"))
        pr (store/read-json pr-path)
        number (:number pr)
        feedback {:pr (json/parse-string (shell! (github-command-opts ctx node) "gh" "pr" "view" (str number)
                                                  "--json" "number,url,title,body,state,comments,reviews,reviewDecision,statusCheckRollup,mergeStateStatus") true)
                  :issue-comments (gh-api-all ctx node (str "repos/" repo "/issues/" number "/comments?per_page=100"))
                  :reviews (gh-api-all ctx node (str "repos/" repo "/pulls/" number "/reviews?per_page=100"))
                  :review-comments (gh-api-all ctx node (str "repos/" repo "/pulls/" number "/comments?per_page=100"))}
        out-path (artifact-path ctx (or (get-in node [:outputs :feedback-json :path]) "pr/feedback/feedback.json"))]
    (write-artifact-json! ctx out-path feedback)
    {:status "ok" :feedback-file out-path}))

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
                              "bash" "-lc" (str "curl -fsS --max-time 2 " (pr-str url) " >/dev/null"))]
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
                              "bash" "-lc" (str "curl -fsS --max-time 2 " (pr-str url)))]
          (if (and (zero? (:exit result)) (str/includes? (str (:out result)) needle))
            true
            (do (Thread/sleep 200)
                (recur (or (:err result) (:out result))))))))))

(defn seed-connections-doctor-project-fixture!
  "Create an ignored, disposable explicit project for manual-review servers.
  The fixture stores only credential references and local paths, so produced
  `:web/start-test-server` artifacts can exercise project switching and doctor
  isolation without requiring reviewers to mutate their checkout by hand."
  [cwd]
  (let [project-id "doctor-explicit"
        default-manifest-path (fs/path cwd ".tesseraft" "projects" "default.json")
        fixture-ws (fs/path cwd ".agent-runs" "manual-connections-doctor-explicit-ws")
        workflows-dir (fs/path fixture-ws ".tesseraft" "workflows" "manual-doctor")
        runs-dir (fs/path fixture-ws "runs")
        explicit-manifest-path (fs/path cwd ".tesseraft" "projects" (str project-id ".json"))
        workflow-path (fs/path workflows-dir "workflow.edn")]
    (fs/create-dirs workflows-dir)
    (fs/create-dirs runs-dir)
    (spit (str workflow-path)
          "{:api-version \"tesseraft.workflow/v1\"\n :kind :workflow\n :metadata {:name \"manual-doctor\" :title \"Manual Doctor\"}\n :defaults {:max-rounds 1 :state-timeout \"1m\"}\n :policies {:require-timeouts true :require-max-rounds true}\n :initial :start\n :states {:start {:type :deterministic\n                  :handler :noop/succeed\n                  :runtime {:timeout \"10s\"}\n                  :next :done}\n          :done {:type :terminal :title \"Done\" :status :success}}}\n")
    (store/write-json! default-manifest-path
                       {:project_id "default"
                        :name "Default"
                        :workspace_root "."
                        :runs_root ".agent-runs"
                        :discovery {:workflow-roots [".tesseraft/workflows" "examples"]}
                        :settings {}})
    (store/write-json! explicit-manifest-path
                       {:project_id project-id
                        :name "Doctor Explicit"
                        :workspace_root ".agent-runs/manual-connections-doctor-explicit-ws"
                        :runs_root "runs"
                        :discovery {:workflow-roots [".tesseraft/workflows"]}
                        :settings {:default-repo-root "missing-repo-root"}
                        :connections {:github {:credential-ref "env:DOCTOR_EXPLICIT_GITHUB_TOKEN"}
                                      :jira {:base-url "https://doctor-explicit.invalid"
                                             :credential-ref "env:DOCTOR_EXPLICIT_JIRA_TOKEN"}}})
    {"project_id" project-id
     "default_manifest" (str default-manifest-path)
     "explicit_manifest" (str explicit-manifest-path)
     "workspace" (str fixture-ws)}))

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
          pi-env {"TESSERAFT_PI_ADAPTER" (or (System/getenv "TESSERAFT_PI_ADAPTER") "fake")}
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
          ua (git-user-args)]
      (spit (str readme-path) readme)
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

(defn notify-pinga! [_wf ctx _state-id _node]
  (let [msg (str "Workflow finished: " (get-in ctx [:workflow :name]) "\nRun dir: " (run-dir ctx) "\n")]
    (if-let [pinga (not-empty (System/getenv "PINGA_BIN"))]
      (shell! {} pinga msg)
      (println msg))
    {:status "ok"}))

(def handlers
  {:jira/fetch-ticket jira-fetch-ticket!
   :git/ensure-branch git-ensure-branch!
   :git/ensure-worktree git-ensure-worktree!
   :git/push git-push!
   :github/create-pr github-create-pr!
   :github/fetch-pr-feedback github-fetch-pr-feedback!
   :web/start-test-server start-test-server!
   :web/stop-test-server stop-test-server!
   :web/capture-ui-evidence capture-ui-evidence!
   :web/validate-ui-review validate-ui-review!
   :git/publish-visual-evidence publish-visual-evidence!
   :notify/pinga notify-pinga!
   :noop/succeed (fn [_wf _ctx _state-id _node] {:status "ok"})})

(defn output-path [ctx node output-key fallback]
  (artifact-path ctx (or (get-in node [:outputs output-key :path]) fallback)))

(defn mock-ticket [ctx]
  (let [ticket (get-in ctx [:inputs :ticket] "MOCK-1")]
    {:key ticket :summary "Mock dry-run ticket" :status "Mock" :mock true}))

(defn mock-pr [ctx node]
  (let [branch (branch-name ctx node)
        base (or (get-in ctx [:inputs :base-branch]) "main")]
    {:number 1
     :url "https://example.invalid/mock/pr/1"
     :state "OPEN"
     :headRefName branch
     :baseRefName base
     :mock true}))

(defn mock-worktree-dir [ctx node]
  (or (artifact-text ctx (get-in node [:inputs :repo-dir-file]))
      (str (fs/path (get-in ctx [:run :dir]) "mock-worktree"))))

(defn mock-test-server [ctx node]
  (let [cwd (absolute-normal-path (repo-dir ctx node))
        doctor-fixture (seed-connections-doctor-project-fixture! cwd)]
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
     :connections_doctor_fixture doctor-fixture
     :mock true
     :live false
     :manual_testing_ready false
     :manual_testing_note "Mock dry run seeded the Connections Doctor project fixture but did not start a live HTTP server. Use a non-mock :web/start-test-server run for browser/API manual review."
     :started_at (store/now)
     :lifecycle {:cleanup "none; mock dry run did not start a process"}}))

(defn run-mock-handler! [_wf ctx _state-id node]
  (case (:handler node)
    :jira/fetch-ticket
    (let [ticket (mock-ticket ctx)
          out-path (output-path ctx node :ticket-json "ticket.json")]
      (write-artifact-json! ctx out-path ticket)
      {:status "ok" :mock true :ticket (:key ticket) :ticket-file out-path})

    :git/ensure-branch
    {:status "ok" :mock true :branch (branch-name ctx node)
     :base-branch (or (get-in ctx [:inputs :base-branch]) (get-in ctx [:workflow :defaults :base-branch]) "main")}

    :git/ensure-worktree
    (let [branch (branch-name ctx node)
          base (or (get-in ctx [:inputs :base-branch]) (get-in ctx [:workflow :defaults :base-branch]) "main")
          path (mock-worktree-dir ctx node)
          out-path (output-path ctx node :worktree-path "worktree/path.txt")]
      (fs/create-dirs path)
      (fs/create-dirs (fs/parent out-path))
      (spit out-path path)
      {:status "ok" :mock true :branch branch :base-branch base :start-point (str "origin/" base) :worktree-dir path :worktree-file out-path})

    :git/push
    {:status "ok" :mock true :branch (branch-name ctx node)}

    :github/create-pr
    (let [pr (mock-pr ctx node)
          pr-file (output-path ctx node :pr-json "pr/pr.json")]
      (write-artifact-json! ctx pr-file pr)
      {:status "ok" :mock true :pr pr :pr-file pr-file})

    :github/fetch-pr-feedback
    (let [feedback {:pr {:number 1 :url "https://example.invalid/mock/pr/1" :state "OPEN" :mock true}
                    :issue-comments []
                    :reviews []
                    :review-comments []}
          out-path (output-path ctx node :feedback-json "pr/feedback/feedback.json")]
      (write-artifact-json! ctx out-path feedback)
      {:status "ok" :mock true :feedback-file out-path})

    :web/start-test-server
    (let [server (mock-test-server ctx node)
          out-path (output-path ctx node :test-server "manual-testing/test-server.json")]
      (write-artifact-json! ctx out-path server)
      {:status "ok"
       :mock true
       :live false
       :manual-testing-ready false
       :connections-doctor-fixture (:connections_doctor_fixture server)
       :test-server-file out-path
       :url (:url server)
       :pid nil})

    :web/stop-test-server
    {:status "ok" :mock true :process-found false :stop-requested false}

    :web/capture-ui-evidence
    (let [evidence {:version 1 :mode "executed" :target_url "http://127.0.0.1:0"
                    :worktree_root (mock-worktree-dir ctx node) :screenshots [] :geometry {}
                    :checks (mapv (fn [id] {:id id :passed true :details {:mock true}}) required-ui-checks)
                    :findings [] :mock true}
          out-path (output-path ctx node :evidence "manual-testing/ui-evidence.json")]
      (write-artifact-json! ctx out-path evidence)
      {:status "pass" :mock true :evidence_file out-path :issues_file nil})

    :web/validate-ui-review
    (let [validation {:status "pass" :summary "Mock UI evidence contract validated" :issues_file nil}
          out-path (output-path ctx node :validation "visual-review/validation.json")]
      (write-artifact-json! ctx out-path validation)
      validation)

    :git/publish-visual-evidence
    (let [published {:status "ok" :mock true :directory "review-evidence/mock" :markdown "## Visual evidence\n\nMock evidence.\n"}
          out-path (output-path ctx node :published "visual-review/published.json")]
      (write-artifact-json! ctx out-path published)
      {:status "ok" :mock true :published_file out-path})

    :notify/pinga
    {:status "ok" :mock true}

    :noop/succeed
    {:status "ok" :mock true}

    (throw (ex-info "Unknown mock deterministic handler" {:handler (:handler node)}))))

(defn run-handler!
  ([wf ctx state-id node] (run-handler! wf ctx state-id node {}))
  ([wf ctx state-id node opts]
   (if (:mock? opts)
     (run-mock-handler! wf ctx state-id node)
     (let [handler (get handlers (:handler node))]
       (when-not handler (throw (ex-info "Unknown deterministic handler" {:handler (:handler node)})))
       (handler wf ctx state-id node)))))
