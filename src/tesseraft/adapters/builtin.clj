(ns tesseraft.adapters.builtin
  (:require
    [tesseraft.spec :as spec]
    [tesseraft.runtime.store :as store]
    [babashka.fs :as fs]
    [babashka.process :as p]
    [cheshire.core :as json]
    [clojure.string :as str]))

(defn shell! [opts & args]
  (let [r (apply p/shell (merge {:out :string :err :string :continue true} opts) args)]
    (when-not (zero? (:exit r))
      (throw (ex-info "Command failed" {:args args :exit (:exit r) :out (:out r) :err (:err r)})))
    (:out r)))
(defn run-dir [ctx] (get-in ctx [:run :dir]))
(defn artifact-path [ctx p]
  (let [rendered (spec/render-template-string p ctx)]
    (str (fs/path (run-dir ctx) rendered))))
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
    (spit out-path raw)
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

(defn github-repo! [ctx node]
  (str/trim (shell! {:dir (repo-dir ctx node)} "gh" "repo" "view" "--json" "nameWithOwner" "--jq" ".nameWithOwner")))

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
  (let [r (p/shell {:dir (repo-dir ctx node) :out :string :err :string :continue true}
                   "gh" "pr" "view" branch "--json" "number,url,state,headRefName,baseRefName")]
    (when (zero? (:exit r)) (json/parse-string (:out r) true))))

(defn github-create-pr! [_wf ctx _state-id node]
  (let [repo (github-repo! ctx node)
        branch (branch-name ctx node)
        base (or (get-in ctx [:inputs :base-branch]) "main")
        title-file (artifact-path ctx (or (get-in node [:inputs :title-file]) "pr/pr-title.txt"))
        body-file (artifact-path ctx (or (get-in node [:inputs :body-file]) "pr/pr-body.md"))
        pr-file (artifact-path ctx (or (get-in node [:outputs :pr-json :path]) "pr/pr.json"))
        ua (git-user-args)
        _ (apply shell! {:dir (repo-dir ctx node)} "git" (concat ua ["push" "-u" "origin" branch]))
        pr (or (github-existing-pr ctx node branch)
               (let [payload-file (artifact-path ctx "pr/create-payload.json")]
                 (store/write-json! payload-file {:title (str/trim (slurp title-file))
                                                  :body (slurp body-file)
                                                  :head branch :base base :draft false})
                 (json/parse-string (shell! {:dir (repo-dir ctx node)} "gh" "api" "--method" "POST"
                                            (str "repos/" repo "/pulls") "--input" payload-file) true)))
        normalized (cond-> {:number (:number pr) :url (github-pr-url repo pr) :state (:state pr)
                            :headRefName (or (:headRefName pr) branch) :baseRefName (or (:baseRefName pr) base)}
                     (some-> (:url pr) non-empty-string github-api-pr-url->browser-url)
                     (assoc :api_url (non-empty-string (:url pr))))]
    (store/write-json! pr-file normalized)
    {:status "ok" :pr normalized :pr-file pr-file}))

(defn gh-api-all [ctx node endpoint]
  (let [raw (shell! {:dir (repo-dir ctx node)} "gh" "api" "--paginate" "--slurp" endpoint)
        pages (json/parse-string raw true)]
    (->> pages (mapcat #(if (sequential? %) % [%])) vec)))
(defn github-fetch-pr-feedback! [_wf ctx _state-id node]
  (let [repo (github-repo! ctx node)
        pr-path (artifact-path ctx (or (get-in node [:inputs :pr-json]) "pr/pr.json"))
        pr (store/read-json pr-path)
        number (:number pr)
        feedback {:pr (json/parse-string (shell! {:dir (repo-dir ctx node)} "gh" "pr" "view" (str number)
                                                  "--json" "number,url,title,body,state,comments,reviews,reviewDecision,statusCheckRollup,mergeStateStatus") true)
                  :issue-comments (gh-api-all ctx node (str "repos/" repo "/issues/" number "/comments?per_page=100"))
                  :reviews (gh-api-all ctx node (str "repos/" repo "/pulls/" number "/reviews?per_page=100"))
                  :review-comments (gh-api-all ctx node (str "repos/" repo "/pulls/" number "/comments?per_page=100"))}
        out-path (artifact-path ctx (or (get-in node [:outputs :feedback-json :path]) "pr/feedback/feedback.json"))]
    (store/write-json! out-path feedback)
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
    (let [doctor-fixture (seed-connections-doctor-project-fixture! cwd)
          ;; Default the manual test server to the fake Pi adapter so the
          ;; compose -> preview -> save flow is deterministic without real
          ;; API spend. Respect an explicitly inherited TESSERAFT_PI_ADAPTER
          ;; so real-SDK manual testing remains opt-in via the parent env.
          pi-env {"TESSERAFT_PI_ADAPTER" (or (System/getenv "TESSERAFT_PI_ADAPTER") "fake")}
          proc (p/process command {:dir cwd :out :pipe :err :pipe :extra-env pi-env})
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
                    :connections_doctor_fixture doctor-fixture
                    :started_at (store/now)
                    :lifecycle {:cleanup "kill pid after manual testing/review run"
                                :cleanup_command (when pid (str "kill " pid))
                                :owner "tesseraft deterministic handler :web/start-test-server"}}]
      (wait-for-http-ok url 10000)
      (store/write-json! out-path artifact)
      {:status "ok" :test-server-file out-path :url url :pid pid})))

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
  {:kind "web-service"
   :name "mock-test-server"
   :url "http://127.0.0.1:0"
   :host (or (get-in node [:inputs :host]) "127.0.0.1")
   :port 0
   :pid nil
   :cwd (mock-worktree-dir ctx node)
   :worktree_root (mock-worktree-dir ctx node)
   :command (mapv str (or (get-in node [:inputs :command]) []))
   :build_command (when-let [cmd (get-in node [:inputs :build-command])] (mapv str cmd))
   :mock true
   :started_at (store/now)
   :lifecycle {:cleanup "none; mock dry run did not start a process"}})

(defn run-mock-handler! [_wf ctx _state-id node]
  (case (:handler node)
    :jira/fetch-ticket
    (let [ticket (mock-ticket ctx)
          out-path (output-path ctx node :ticket-json "ticket.json")]
      (store/write-json! out-path ticket)
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
      (store/write-json! pr-file pr)
      {:status "ok" :mock true :pr pr :pr-file pr-file})

    :github/fetch-pr-feedback
    (let [feedback {:pr {:number 1 :url "https://example.invalid/mock/pr/1" :state "OPEN" :mock true}
                    :issue-comments []
                    :reviews []
                    :review-comments []}
          out-path (output-path ctx node :feedback-json "pr/feedback/feedback.json")]
      (store/write-json! out-path feedback)
      {:status "ok" :mock true :feedback-file out-path})

    :web/start-test-server
    (let [server (mock-test-server ctx node)
          out-path (output-path ctx node :test-server "manual-testing/test-server.json")]
      (store/write-json! out-path server)
      {:status "ok" :mock true :test-server-file out-path :url (:url server) :pid nil})

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
