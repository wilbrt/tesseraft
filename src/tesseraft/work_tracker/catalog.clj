(ns tesseraft.work-tracker.catalog
  (:require
    [clojure.string :as str]
    [tesseraft.work-tracker.github-issues :as github-issues]
    [tesseraft.work-tracker.jira :as jira]
    [tesseraft.work-tracker.plane :as plane]))

(defn- present-string? [value]
  (and (string? value) (not (str/blank? value))))

(defn- valid-http-url? [value]
  (try
    (let [uri (java.net.URI. value)
          scheme (some-> (.getScheme uri) str/lower-case)]
      (and (present-string? value)
           (contains? #{"http" "https"} scheme)
           (present-string? (.getHost uri))))
    (catch Throwable _ false)))

(defn- validate-plane [config]
  (cond
    (not (valid-http-url? (:api-base-url config))) "plane api-base-url must be an http(s) URL"
    (not (present-string? (:workspace-slug config))) "plane workspace-slug is required"
    (not (present-string? (:project-id config))) "plane project-id is required"
    :else nil))

(defn- validate-jira [config]
  (cond
    (not (valid-http-url? (:base-url config))) "jira base-url must be an http(s) URL"
    (not (present-string? (:project-key config))) "jira project-key is required"
    :else nil))

(defn- validate-github-issues [config]
  (when-not (and (string? (:repository config))
                 (re-matches #"[^/\s]+/[^/\s]+" (:repository config)))
    "github-issues repository must be owner/name"))

(defn- fetch-plane [args] (plane/fetch-item (assoc args :api-key (:credential args))))
(defn- fetch-jira [args] (jira/fetch-item (assoc args :token (:credential args))))
(defn- fetch-github-issues [args] (github-issues/fetch-item (assoc args :token (:credential args))))

(def descriptors
  {:plane
   {:id :plane :label "Plane" :normalized-provider "plane"
    :validate-config validate-plane :fetch-item fetch-plane
    :mock-scope (fn [config] {:workspace_slug (or (:workspace-slug config) "mock-workspace")
                              :project_id (or (:project-id config) "mock-plane-project")})
    :doctor (fn [config] (if-let [error (validate-plane config)]
                           {:status "invalid" :reason error} {:status "ready"}))
    :form-fields [{:name :api-base-url :label "API base URL" :type "url" :required true :placeholder "https://api.plane.so"}
                  {:name :workspace-slug :label "Workspace slug" :type "text" :required true :placeholder "example-workspace"}
                  {:name :project-id :label "Project ID" :type "text" :required true :placeholder "plane-project-uuid"}]}
   :jira
   {:id :jira :label "Jira" :normalized-provider "jira"
    :validate-config validate-jira :fetch-item fetch-jira
    :mock-scope (fn [config] {:project_key (or (:project-key config) "MOCK")})
    :doctor (fn [config] (if-let [error (validate-jira config)]
                           {:status "invalid" :reason error} {:status "ready"}))
    :form-fields [{:name :base-url :label "Base URL" :type "url" :required true :placeholder "https://your-domain.atlassian.net"}
                  {:name :project-key :label "Project key" :type "text" :required true :placeholder "TES"}]}
   :github-issues
   {:id :github-issues :label "GitHub Issues" :normalized-provider "github-issues"
    :validate-config validate-github-issues :fetch-item fetch-github-issues
    :mock-scope (fn [config] {:repository (or (:repository config) "mock/repo")})
    :doctor (fn [config] (if-let [error (validate-github-issues config)]
                           {:status "invalid" :reason error} {:status "ready"}))
    :form-fields [{:name :repository :label "Repository (owner/name)" :type "text" :required true :placeholder "owner/name"}]}})

(defn ids [] (set (keys descriptors)))
(defn descriptor [provider] (get descriptors provider))

(defn validate-config [provider config]
  (when-let [f (:validate-config (descriptor provider))] (f config)))

(defn fetch-item [provider args]
  (if-let [f (:fetch-item (descriptor provider))]
    (f args)
    {:ok false :status "error" :category "unsupported_provider"
     :message "Unsupported work-tracker fetch provider"}))

(defn mock-scope [provider config]
  (if-let [f (:mock-scope (descriptor provider))] (f config) {}))

(defn public-descriptors []
  (mapv (fn [descriptor]
          {:provider (name (:id descriptor))
           :label (:label descriptor)
           :normalized_provider (:normalized-provider descriptor)
           :fields (:form-fields descriptor)
           :credential_ref {:required true}})
        (sort-by (comp name :id) (vals descriptors))))
