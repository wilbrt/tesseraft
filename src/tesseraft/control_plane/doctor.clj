(ns tesseraft.control-plane.doctor
  (:require
    [tesseraft.control-plane.core :as cp]
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.string :as str])
  (:import [java.util.concurrent TimeUnit TimeoutException]))

(def statuses ["ready" "not-configured" "unreachable" "invalid"])
(def check-order ["github-credential" "github-auth" "jira-base-url" "jira-credential" "pi-provider-model" "git-author" "repository-root" "pinga" "workflow-discovery" "runs-root"])

(defn- now-ms [] (System/currentTimeMillis))
(defn- blank? [v] (or (nil? v) (str/blank? (str v))))
(defn- kwget [m & ks] (some (fn [k] (get m k)) ks))
(defn- setting [project k]
  (let [s (:settings project {})]
    (kwget s k (keyword (str/replace (name k) #"_" "-")) (keyword (str/replace (name k) #"-" "_")) (name k) (str/replace (name k) #"_" "-") (str/replace (name k) #"-" "_"))))
(defn- conn [project k] (or (get-in project [:connections k]) (get-in project [:connections (name k)])))
(defn- conn-val [c k] (kwget c k (keyword (str/replace (name k) #"-" "_")) (name k) (str/replace (name k) #"-" "_")))

(defn- resolved-token [options ref]
  (:value (cp/resolve-credential options ref)))

(defn- redact-value [s secrets]
  (reduce (fn [acc secret]
            (if (and (string? secret) (not (str/blank? secret)))
              (str/replace acc secret "[redacted]")
              acc))
          (str s) secrets))

(defn- scrub [x secrets]
  (cond
    (string? x) (redact-value x secrets)
    (map? x) (into {} (map (fn [[k v]] [k (scrub v secrets)])) x)
    (vector? x) (mapv #(scrub % secrets) x)
    (seq? x) (mapv #(scrub % secrets) x)
    :else x))

(defn- process-run [{:keys [cmd cwd env timeout-ms]}]
  (try
    (let [pb (ProcessBuilder. (mapv str cmd))]
      (when cwd (.directory pb (fs/file cwd)))
      (when env
        (let [pe (.environment pb)]
          (doseq [[k v] env]
            (when-not (nil? v) (.put pe (str k) (str v))))))
      (.redirectErrorStream pb true)
      (let [p (.start pb)
            ok? (.waitFor p (long (or timeout-ms 4000)) TimeUnit/MILLISECONDS)]
        (if-not ok?
          (do (.destroyForcibly p) {:timeout true :exit nil})
          {:timeout false :exit (.exitValue p)})))
    (catch java.io.IOException _ {:missing true :exit nil})
    (catch Throwable _ {:exception true :exit nil})))

(defn- executable? [p]
  (and (not (blank? p)) (fs/exists? p) (.canExecute (fs/file p))))

(defn- command-available? [cmd]
  (let [r (process-run {:cmd ["sh" "-c" (str "command -v " cmd " >/dev/null 2>&1")] :timeout-ms 1000})]
    (zero? (or (:exit r) 1))))

(defn- check [id label mode f]
  (let [start (now-ms)
        base {:id id :label label :mode mode}]
    (try
      (let [r (f)]
        (merge base r {:duration_ms (max 0 (- (now-ms) start))}))
      (catch TimeoutException _
        (merge base {:status "unreachable" :summary "The check timed out." :remediation "Retry after confirming the local tool is responsive." :duration_ms (max 0 (- (now-ms) start))}))
      (catch Throwable _
        (merge base {:status "invalid" :summary "The check failed before it could classify readiness." :remediation "Review the local configuration and retry." :duration_ms (max 0 (- (now-ms) start))})))))

(defn- credential-check [options project service]
  (let [c (conn project service)
        ref (conn-val c :credential-ref)]
    (cond
      (blank? ref) {:status "not-configured" :summary (str (str/capitalize (name service)) " credential reference is not configured.") :remediation "Configure a credential reference such as env:NAME."}
      (= "invalid" (:state (cp/resolve-credential options ref))) {:status "invalid" :summary "Credential reference has invalid syntax or the selected store is invalid." :remediation "Use env:NAME, tesseraft:NAME, or github-actions:NAME; do not store raw secrets."}
      (resolved-token options ref) {:status "ready" :summary (str "Credential reference " ref " resolves locally.") :remediation nil}
      :else {:status "not-configured" :summary (str "Credential reference " ref " does not resolve locally.") :remediation "Set the referenced environment variable or local credential-store entry."})))

(defn- github-auth-check [options project]
  (let [ref (conn-val (conn project :github) :credential-ref)
        token (resolved-token options ref)]
    (cond
      (not (command-available? "gh")) {:status "not-configured" :summary "GitHub CLI (gh) is not installed or not on PATH." :remediation "Install gh and authenticate, or configure a GitHub credential reference."}
      :else
      (let [env (cond-> {} token (assoc "GH_TOKEN" token "GITHUB_TOKEN" token))
            r (process-run {:cmd ["gh" "auth" "status"] :env env :timeout-ms 4000})]
        (cond
          (:timeout r) {:status "unreachable" :summary "gh auth status timed out." :remediation "Retry after checking local gh/network responsiveness."}
          (= 0 (:exit r)) {:status "ready" :summary "gh authentication is available." :remediation nil}
          :else {:status "invalid" :summary "gh authentication was rejected or incomplete." :remediation "Run gh auth login or fix the configured credential reference."})))))

(defn- jira-base-url-check [project]
  (let [u (conn-val (conn project :jira) :base-url)]
    (cond
      (blank? u) {:status "not-configured" :summary "Jira base URL is not configured." :remediation "Set the project Jira base URL."}
      :else (try
              (let [uri (java.net.URI. (str u))]
                (cond
                  (not (#{"http" "https"} (.getScheme uri))) {:status "invalid" :summary "Jira base URL must use http or https." :remediation "Use an absolute HTTPS URL such as https://example.atlassian.net."}
                  (blank? (.getHost uri)) {:status "invalid" :summary "Jira base URL must be absolute." :remediation "Use an absolute HTTPS URL."}
                  (not (blank? (.getUserInfo uri))) {:status "invalid" :summary "Jira base URL must not include user info." :remediation "Remove embedded credentials from the URL."}
                  :else {:status "ready" :summary "Jira base URL is configured (static check only)." :remediation nil}))
              (catch Throwable _ {:status "invalid" :summary "Jira base URL is malformed." :remediation "Use an absolute HTTP(S) URL."})))))

(defn- pi-check [project]
  (let [provider (or (setting project :pi-default-provider) (setting project :pi_default_provider))
        model (or (setting project :pi-default-model) (setting project :pi_default_model))]
    (cond
      (and (blank? provider) (blank? model)) {:status "not-configured" :summary "Pi provider/model defaults are not configured." :remediation "Set both a default provider and model."}
      (or (blank? provider) (blank? model)) {:status "invalid" :summary "Pi provider and model must be configured together." :remediation "Set both fields or clear both fields."}
      (not (command-available? "pi")) {:status "not-configured" :summary "Pi executable is not available for local catalog checks." :remediation "Install pi or ensure it is on PATH."}
      :else (let [r (process-run {:cmd ["pi" "--offline" "--list-models" (str provider "/" model)] :timeout-ms 4000})]
              (cond
                (:timeout r) {:status "unreachable" :summary "Pi local model catalog check timed out." :remediation "Retry after checking the local Pi installation."}
                (= 0 (:exit r)) {:status "ready" :summary "Pi provider/model appears in the local catalog." :remediation nil}
                :else {:status "invalid" :summary "Pi provider/model was not accepted by the local catalog." :remediation "Choose a provider/model listed by pi offline catalog."})))))

(defn- repo-root [options project]
  (let [sopts (cp/project-scoped-opts options (:project_id project))
        configured (or (setting project :default-repo-root) (setting project :default_repo_root) ".")]
    (fs/absolutize (cp/abs-path (:workspace-root sopts) configured))))

(defn- repository-check [options project]
  (let [root (repo-root options project)]
    (cond
      (not (fs/exists? root)) {:status "invalid" :summary "Repository root does not exist." :remediation "Create the directory or update the project default repo root."}
      (not (fs/directory? root)) {:status "invalid" :summary "Repository root is not a directory." :remediation "Point the project at a directory."}
      (not (.canRead (fs/file root))) {:status "invalid" :summary "Repository root is not readable by this process." :remediation "Fix local permissions."}
      (not (.canWrite (fs/file root))) {:status "invalid" :summary "Repository root is not writable by this process." :remediation "Fix local permissions or choose a writable checkout."}
      :else (let [r (process-run {:cmd ["git" "rev-parse" "--is-inside-work-tree"] :cwd root :timeout-ms 3000})]
              (cond
                (:timeout r) {:status "unreachable" :summary "Git repository check timed out." :remediation "Retry after checking the local repository."}
                (= 0 (:exit r)) {:status "ready" :summary "Repository root exists and is a readable/writable Git work tree." :remediation nil}
                :else {:status "invalid" :summary "Repository root is not inside a Git work tree." :remediation "Choose a Git checkout or initialize the repository."})))))

(defn- git-author-check [options project]
  (let [configured (cp/get-git-user options (:project_id project))
        gu (get configured :git_user)
        root (repo-root options project)]
    (if (and (not (blank? (:name gu))) (not (blank? (:email gu))))
      {:status "ready" :summary (str "Git author identity is configured from " (:source gu) " settings.") :remediation nil}
      (let [name-r (process-run {:cmd ["git" "config" "--get" "user.name"] :cwd root :timeout-ms 2000})
            email-r (process-run {:cmd ["git" "config" "--get" "user.email"] :cwd root :timeout-ms 2000})]
        (cond
          (or (:timeout name-r) (:timeout email-r)) {:status "unreachable" :summary "Git author lookup timed out." :remediation "Retry after checking local git responsiveness."}
          (and (= 0 (:exit name-r)) (= 0 (:exit email-r))) {:status "ready" :summary "Git author identity is available from repository git config." :remediation nil}
          :else {:status "not-configured" :summary "Git author name/email are not configured." :remediation "Set Tesseraft Git identity or git config user.name and user.email."})))))

(defn- pinga-check []
  (let [bin (System/getenv "PINGA_BIN")]
    (cond
      (blank? bin) {:status "not-configured" :summary "PINGA_BIN is not configured." :remediation "Set PINGA_BIN to the local Pinga executable when notifications are desired."}
      (not (executable? bin)) {:status "invalid" :summary "PINGA_BIN does not point to an executable file." :remediation "Update PINGA_BIN to an executable path."}
      :else {:status "ready" :summary "Pinga executable is configured (static check only; not executed)." :remediation nil})))

(defn- workflow-check [options project]
  (let [r (cp/list-workflows options (:project_id project))
        w (:workflows r)]
    (cond
      (:error r) {:status "invalid" :summary "Workflow discovery failed." :remediation "Fix project workflow discovery configuration."}
      (empty? w) {:status "not-configured" :summary "No visible workflows were discovered." :remediation "Add a workflow.edn under a configured workflow root."}
      (some #(or (:error %) (seq (:conflicts %))) w) {:status "invalid" :summary "Workflow discovery found parse errors or conflicts." :remediation "Fix invalid workflow files or same-precedence name conflicts."}
      :else {:status "ready" :summary "Workflow discovery found visible workflows." :remediation nil})))

(defn- runs-root-check [options project]
  (let [sopts (cp/project-scoped-opts options (:project_id project))
        root (fs/absolutize (cp/abs-path (:workspace-root sopts) (:runs-root sopts)))]
    (cond
      (not (fs/exists? root)) {:status "not-configured" :summary "Runs root does not exist." :remediation "Create the runs root directory or start a run to initialize it."}
      (not (fs/directory? root)) {:status "invalid" :summary "Runs root is not a directory." :remediation "Point runs_root at a directory."}
      (not (.canRead (fs/file root))) {:status "invalid" :summary "Runs root is not readable by this process." :remediation "Fix local permissions."}
      (not (.canWrite (fs/file root))) {:status "invalid" :summary "Runs root is not writable by this process." :remediation "Fix local permissions."}
      :else {:status "ready" :summary "Runs root exists and is readable/writable." :remediation nil})))

(defn doctor-report
  ([] (doctor-report {} nil))
  ([options project-id]
   (let [project (cp/resolve-project options project-id)]
     (if (:error project)
       project
       (let [github-secret (resolved-token options (conn-val (conn project :github) :credential-ref))
             jira-secret (resolved-token options (conn-val (conn project :jira) :credential-ref))
             secrets (remove blank? [github-secret jira-secret])
             checks [(check "github-credential" "GitHub credential reference" "static" #(credential-check options project :github))
                     (check "github-auth" "GitHub authentication" "read-only" #(github-auth-check options project))
                     (check "jira-base-url" "Jira base URL" "static" #(jira-base-url-check project))
                     (check "jira-credential" "Jira credential reference" "static" #(credential-check options project :jira))
                     (check "pi-provider-model" "Pi provider and model" "read-only" #(pi-check project))
                     (check "git-author" "Git author identity" "read-only" #(git-author-check options project))
                     (check "repository-root" "Repository root" "read-only" #(repository-check options project))
                     (check "pinga" "Pinga executable and configuration" "static" #(pinga-check))
                     (check "workflow-discovery" "Workflow discovery" "read-only" #(workflow-check options project))
                     (check "runs-root" "Runs root" "static" #(runs-root-check options project))]
             summary (into {} (for [s statuses] [s (count (filter #(= s (:status %)) checks))]))]
         (scrub (cp/api-value {:project_id (:project_id project)
                               :summary summary
                               :checks (sort-by #(.indexOf check-order (:id %)) checks)})
                secrets))))))

(defn json-safe? [report]
  (not (str/includes? (json/generate-string report) "SECRET_SENTINEL")))
