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
(defn repo-dir [ctx] (or (get-in ctx [:inputs :repo-root]) (get-in ctx [:inputs :repo]) "."))
(defn render-command [ctx command-template] (spec/render-template-string command-template ctx))
(defn artifact-text [ctx p]
  (when p
    (let [path (artifact-path ctx p)]
      (when (fs/exists? path)
        (str/trim (slurp path))))))
(defn branch-name [ctx node]
  (or (not-empty (get-in ctx [:inputs :branch]))
      (not-empty (artifact-text ctx (get-in node [:inputs :branch-file])))
      (str "agent/" (str/lower-case (get-in ctx [:inputs :ticket] "workflow")))))
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
        repo (repo-dir ctx)]
    (shell! {:dir repo} "git" "fetch" "origin")
    (let [exists? (git-ref-exists? repo branch)
          start-point (base-ref ctx base)]
      (if exists?
        (shell! {:dir repo} "git" "checkout" branch)
        (shell! {:dir repo} "git" "checkout" "-b" branch start-point))
      {:status "ok" :branch branch :base-branch base :start-point start-point})))

(defn git-push! [_wf ctx _state-id node]
  (let [branch (branch-name ctx node)]
    (shell! {:dir (repo-dir ctx)} "git" "push" "origin" branch)
    {:status "ok" :branch branch}))

(defn github-repo! [ctx]
  (str/trim (shell! {:dir (repo-dir ctx)} "gh" "repo" "view" "--json" "nameWithOwner" "--jq" ".nameWithOwner")))
(defn github-existing-pr [ctx branch]
  (let [r (p/shell {:dir (repo-dir ctx) :out :string :err :string :continue true}
                   "gh" "pr" "view" branch "--json" "number,url,state,headRefName,baseRefName")]
    (when (zero? (:exit r)) (json/parse-string (:out r) true))))

(defn github-create-pr! [_wf ctx _state-id node]
  (let [repo (github-repo! ctx)
        branch (branch-name ctx node)
        base (or (get-in ctx [:inputs :base-branch]) "main")
        title-file (artifact-path ctx (or (get-in node [:inputs :title-file]) "pr/pr-title.txt"))
        body-file (artifact-path ctx (or (get-in node [:inputs :body-file]) "pr/pr-body.md"))
        pr-file (artifact-path ctx (or (get-in node [:outputs :pr-json :path]) "pr/pr.json"))
        _ (shell! {:dir (repo-dir ctx)} "git" "push" "-u" "origin" branch)
        pr (or (github-existing-pr ctx branch)
               (let [payload-file (artifact-path ctx "pr/create-payload.json")]
                 (store/write-json! payload-file {:title (str/trim (slurp title-file))
                                                  :body (slurp body-file)
                                                  :head branch :base base :draft false})
                 (json/parse-string (shell! {:dir (repo-dir ctx)} "gh" "api" "--method" "POST"
                                            (str "repos/" repo "/pulls") "--input" payload-file) true)))
        normalized {:number (:number pr) :url (or (:url pr) (:html_url pr)) :state (:state pr)
                    :headRefName (or (:headRefName pr) branch) :baseRefName (or (:baseRefName pr) base)}]
    (store/write-json! pr-file normalized)
    {:status "ok" :pr normalized :pr-file pr-file}))

(defn gh-api-all [ctx endpoint]
  (let [raw (shell! {:dir (repo-dir ctx)} "gh" "api" "--paginate" "--slurp" endpoint)
        pages (json/parse-string raw true)]
    (->> pages (mapcat #(if (sequential? %) % [%])) vec)))
(defn github-fetch-pr-feedback! [_wf ctx _state-id node]
  (let [repo (github-repo! ctx)
        pr-path (artifact-path ctx (or (get-in node [:inputs :pr-json]) "pr/pr.json"))
        pr (store/read-json pr-path)
        number (:number pr)
        feedback {:pr (json/parse-string (shell! {:dir (repo-dir ctx)} "gh" "pr" "view" (str number)
                                                  "--json" "number,url,title,body,state,comments,reviews,reviewDecision,statusCheckRollup,mergeStateStatus") true)
                  :issue-comments (gh-api-all ctx (str "repos/" repo "/issues/" number "/comments?per_page=100"))
                  :reviews (gh-api-all ctx (str "repos/" repo "/pulls/" number "/reviews?per_page=100"))
                  :review-comments (gh-api-all ctx (str "repos/" repo "/pulls/" number "/comments?per_page=100"))}
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
   :git/push git-push!
   :github/create-pr github-create-pr!
   :github/fetch-pr-feedback github-fetch-pr-feedback!
   :notify/pinga notify-pinga!
   :noop/succeed (fn [_wf _ctx _state-id _node] {:status "ok"})})

(defn run-handler! [wf ctx state-id node]
  (let [handler (get handlers (:handler node))]
    (when-not handler (throw (ex-info "Unknown deterministic handler" {:handler (:handler node)})))
    (handler wf ctx state-id node)))
