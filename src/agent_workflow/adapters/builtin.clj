(ns agent-workflow.adapters.builtin
  (:require
    [agent-workflow.spec :as spec]
    [agent-workflow.runtime.store :as store]
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
(defn artifact-path [ctx p] (str (fs/path (run-dir ctx) p)))
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
        repo (repo-dir ctx node)]
    (shell! {:dir repo} "git" "fetch" "origin")
    (let [exists? (git-ref-exists? repo branch)
          start-point (base-ref (assoc-in ctx [:inputs :repo-root] repo) base)]
      (if exists?
        (shell! {:dir repo} "git" "checkout" branch)
        (shell! {:dir repo} "git" "checkout" "-b" branch start-point))
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
                                        "worktree/path.txt"))]
    (shell! {:dir repo} "git" "fetch" "origin")
    (let [start-point (base-ref (assoc-in ctx [:inputs :repo-root] repo) base)]
      (fs/create-dirs (fs/parent path))
      (ensure-worktree-path! repo branch path start-point)
      (fs/create-dirs (fs/parent out-path))
      (spit out-path path)
      {:status "ok" :branch branch :base-branch base :start-point start-point :worktree-dir path :worktree-file out-path})))

(defn git-push! [_wf ctx _state-id node]
  (let [branch (branch-name ctx node)]
    (shell! {:dir (repo-dir ctx node)} "git" "push" "origin" branch)
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
        _ (shell! {:dir (repo-dir ctx node)} "git" "push" "-u" "origin" branch)
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
   :notify/pinga notify-pinga!
   :noop/succeed (fn [_wf _ctx _state-id _node] {:status "ok"})})

(defn run-handler! [wf ctx state-id node]
  (let [handler (get handlers (:handler node))]
    (when-not handler (throw (ex-info "Unknown deterministic handler" {:handler (:handler node)})))
    (handler wf ctx state-id node)))
