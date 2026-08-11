(ns tesseraft.handlers.github
  (:require [babashka.process :as p]
            [cheshire.core :as json]
            [clojure.string :as str]
            [tesseraft.credentials.store :as credentials]
            [tesseraft.handlers.common :as common]
            [tesseraft.handlers.git :as git]
            [tesseraft.runtime.store :as store]))

(def shell! common/shell!)
(def artifact-path common/artifact-path)
(def write-artifact-json! common/write-artifact-json!)
(def repo-dir common/repo-dir)
(def output-path common/output-path)
(def branch-name git/branch-name)
(def git-user-args git/git-user-args)
(def credential-options common/credential-options)
(def project-context common/project-context)

(defn github-token
  ([] (github-token {} nil))
  ([ctx project]
   (let [options (credential-options ctx)
         code-host (get-in project [:connections :code-host])
         ref (:credential-ref code-host)
         token (:value (credentials/resolve options ref))]
     (when-not (str/blank? token) token))))

(defn github-command-opts [ctx node]
  (let [project-id (get-in ctx [:run :project-id])
        project (project-context ctx project-id)
        token (github-token ctx project)]
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
        ua (git-user-args ctx)
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

(defn mock-pr [ctx node]
  (let [branch (branch-name ctx node)
        base (or (get-in ctx [:inputs :base-branch]) "main")]
    {:number 1
     :url "https://example.invalid/mock/pr/1"
     :state "OPEN"
     :headRefName branch
     :baseRefName base
     :mock true}))

(defn mock-github-create-pr! [_wf ctx _state-id node]
  (let [pr (mock-pr ctx node)
          pr-file (output-path ctx node :pr-json "pr/pr.json")]
    (write-artifact-json! ctx pr-file pr)
    {:status "ok" :mock true :pr pr :pr-file pr-file}))

(defn mock-github-fetch-pr-feedback! [_wf ctx _state-id node]
  (let [feedback {:pr {:number 1 :url "https://example.invalid/mock/pr/1" :state "OPEN" :mock true}
                    :issue-comments []
                    :reviews []
                    :review-comments []}
          out-path (output-path ctx node :feedback-json "pr/feedback/feedback.json")]
    (write-artifact-json! ctx out-path feedback)
    {:status "ok" :mock true :feedback-file out-path}))
