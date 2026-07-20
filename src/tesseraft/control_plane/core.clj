(ns tesseraft.control-plane.core
  (:require
    [tesseraft.lint.core :as lint]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.string :as str]))

(def default-options
  {:workspace-root "."
   :workflow-roots ["examples"]
   :tesseraft-home nil
   :runs-root ".agent-runs"})

(defn opts [options]
  (merge default-options options))

(defn api-value [x]
  (cond
    (keyword? x) (name x)
    (map? x) (into {} (map (fn [[k v]] [(if (keyword? k) (name k) (str k)) (api-value v)])) x)
    (vector? x) (mapv api-value x)
    (seq? x) (mapv api-value x)
    (set? x) (mapv api-value x)
    :else x))

(defn error-response
  ([status code message] (error-response status code message {}))
  ([status code message details]
   {:status status
    :error {:code code :message message :details (api-value details)}}))

(defn abs-path [workspace-root p]
  (let [path (fs/path p)]
    (if (fs/absolute? path)
      (fs/normalize path)
      (fs/normalize (fs/path workspace-root path)))))

(defn path-prefix? [parent child]
  (let [parent* (str (fs/normalize parent))
        child* (str (fs/normalize child))]
    (or (= parent* child*)
        (str/starts-with? child* (str parent* java.io.File/separator)))))

(defn relative-path [workspace-root p]
  (try
    (let [root (abs-path workspace-root ".")
          path (abs-path workspace-root p)]
      (if (path-prefix? root path)
        (str (fs/relativize root path))
        (str path)))
    (catch Throwable _
      (str p))))

(defn tesseraft-home [options]
  (or (:tesseraft-home (opts options))
      (System/getenv "TESSERAFT_HOME")
      (str (fs/path (System/getProperty "user.home") ".tesseraft"))))

;; ============================================================
;; First-class Project abstraction (design §4)
;; ============================================================
;; A Project is a named configuration record addressed by a stable `project_id`
;; slug. It owns a workspace root, run root, workflow discovery context,
;; non-secret settings, and project-specific Jira/GitHub connection config.
;; Raw credentials are kept OUT of repositories behind `credential-ref`s that
;; resolve from an out-of-repo store (`~/.tesseraft/credentials.json`). Project
;; manifests live under `.tesseraft/projects/<slug>.json` and are safe to commit.
;;
;; Backward compatibility: when no project manifests exist, a *default* project
;; is synthesized from the current `default-options` + legacy
;; `.tesseraft/settings.json`/`git-user.json`. Legacy files remain a read
;; fallback (migration, not cutover).

(def ^:private project-id-re #"^[a-z0-9][a-z0-9-]{0,62}$")

(def ^:private credential-ref-re #"^(env|github-actions):([^\s]+)$")

(defn valid-project-id? [s]
  (and (string? s) (re-matches project-id-re s)))

(defn slugify-project-name
  "Derive a stable lowercase `[a-z0-9-]` slug from a project name. Falls back
  to `project` when the input cannot be reduced to a usable slug."
  [name]
  (let [base (-> (str name)
                 (str/lower-case)
                 (str/replace #"[^a-z0-9]+" "-")
                 (str/replace #"^-+|-+$" ""))]
    (if (and (seq base) (re-matches project-id-re base))
      base
      "project")))

(defn credential-ref?
  "True if `s` is a credential reference of the form `<store>:<path>`. Only
  `env:` and `github-actions:` stores are recognized shape-wise; resolution is
  only wired for `env:` in the initial implementation."
  [s]
  (and (string? s) (re-find credential-ref-re s)))

(defn projects-dir [options]
  (fs/path (:workspace-root (opts options)) ".tesseraft" "projects"))

(defn project-manifest-path [options project-id]
  (fs/path (projects-dir options) (str project-id ".json")))

(defn credentials-file [options]
  (fs/path (tesseraft-home options) "credentials.json"))

(defn read-project-manifest [options project-id]
  (let [p (project-manifest-path options project-id)]
    (when (fs/exists? p)
      (try (store/read-json p) (catch Throwable _ nil)))))

(defn- project-descriptor-path [project-root]
  (fs/path project-root ".tesseraft" "project.json"))

(defn- normalize-project-descriptor [project-root raw]
  (let [discovery (:discovery raw {})]
    (-> raw
        (assoc :workspace_root (str (fs/normalize (fs/path project-root))))
        (update :runs_root #(or % "runs"))
        (assoc :discovery
               (cond-> {}
                 (contains? discovery :workflow_roots)
                 (assoc :workflow-roots (:workflow_roots discovery))
                 (contains? discovery :workflow-roots)
                 (assoc :workflow-roots (:workflow-roots discovery))
                 (contains? discovery :tesseraft_home)
                 (assoc :tesseraft-home (:tesseraft_home discovery))
                 (contains? discovery :tesseraft-home)
                 (assoc :tesseraft-home (:tesseraft-home discovery)))))))

(defn- nearest-project-descriptor-root [start]
  (loop [dir (fs/normalize (fs/path start))]
    (let [descriptor (project-descriptor-path dir)
          parent (fs/parent dir)]
      (cond
        (fs/exists? descriptor) dir
        (or (nil? parent) (= dir parent)) nil
        :else (recur parent)))))

(defn read-project-descriptor [options]
  (let [options* (opts options)
        explicit-root (:project-root options*)
        root (if explicit-root
               (abs-path (:workspace-root options*) explicit-root)
               (nearest-project-descriptor-root (abs-path (:workspace-root options*) ".")))]
    (when root
      (let [p (project-descriptor-path root)]
        (if-not (fs/exists? p)
          (error-response 400 "invalid_project_descriptor"
                          "Explicit project root is missing .tesseraft/project.json descriptor"
                          {:project_root (str root)
                           :descriptor_path (str p)})
          (try
            (normalize-project-descriptor root (store/read-json p))
            (catch Throwable t
              (error-response 400 "invalid_project_descriptor"
                              (if explicit-root
                                "Explicit project root has an unreadable .tesseraft/project.json descriptor"
                                "Discovered project root has an unreadable .tesseraft/project.json descriptor")
                              {:project_root (str root)
                               :descriptor_path (str p)
                               :message (.getMessage t)}))))))))

(defn list-project-manifests [options]
  (let [dir (projects-dir options)]
    (if-not (fs/exists? dir)
      []
      (->> (for [f (file-seq (fs/file dir))
                 :when (and (.isFile f)
                            (str/ends-with? (.getName f) ".json"))]
             (let [slug (str/replace (.getName f) #"\.json$" "")]
               (try (let [m (store/read-json (fs/path f))]
                      (cond-> {:project_id slug
                               :name (or (:name m) slug)
                               :source (or (:source m) "manifest")}
                        (:workspace_root m) (assoc :workspace_root (:workspace_root m))))
                    (catch Throwable _ nil))))
           (remove nil?)
           vec))))

(defn read-credentials [options]
  (let [p (credentials-file options)]
    (when (fs/exists? p)
      (try (store/read-json p) (catch Throwable _ nil)))))

(defn- norm-discovery [raw]
  (cond
    (nil? raw) nil
    (map? raw)
    (into {} (for [k [:workflow-roots :tesseraft-home]
                   :when (contains? raw k)]
               [k (get raw k)]))
    :else nil))

(defn- norm-connections [raw]
  (if (or (nil? raw) (not (map? raw))) {}
    (into {} (for [[k v] raw
                   :when (#{:jira :github :jira/* :github/* "jira" "github"} k)
                   :when (map? v)]
               [(if (keyword? k) k (keyword k)) v]))))

;; ---- settings config (source of truth: .tesseraft/settings.json) ----
;; Defined early so the default-project synthesizer (below) can resolve these
;; symbols at sci analysis time. The full settings read/mutate surface
;; (`get-settings`/`set-settings`/`validate-settings-field`/`mask-settings`)
;; remains further down; only the small read + mask helpers needed by project
;; synthesis are hoisted here. Mirrors git-user precedence (project then global).
;; Tokens are returned masked so secrets never leave the process; the file is
;; plaintext (local-only, no auth model) under the already-gitignored
;; .tesseraft/ directory.

(def ^:private settings-fields
  [:pi_default_provider :pi_default_model :github_token
   :jira_token :default_repo_root :color_scheme])

;; Sentinel for "leave this token field as-is" (used by the web API to round-trip
;; masked tokens safely). See docs in `set-settings`.
(def settings-unchanged "__unchanged__")

(defn settings-paths [options]
  (let [{:keys [workspace-root]} (opts options)
        home (tesseraft-home options)]
    {:project (fs/path workspace-root ".tesseraft" "settings.json")
     :global (fs/path home "settings.json")}))

(defn read-settings-file [p]
  (when (fs/exists? p)
    (try (store/read-json p) (catch Throwable _ nil))))

(defn coerce-settings
  "Keep only the known settings fields from a parsed config map. Unknown
  fields are dropped (ignored on read)."
  [raw]
  (if (map? raw)
    (into {} (for [k settings-fields :when (contains? raw k)] [k (get raw k)]))
    {}))

(defn mask-token [v]
  (if (or (nil? v) (not (string? v)) (str/blank? v))
    {:present false}
    {:present true :preview (subs (str v) (max 0 (- (count (str v)) 4)))}))

(defn synthesize-default-project
  "Build the implicit default project from `default-options` + legacy
  `.tesseraft/settings.json`/`git-user.json`. Returns a map with `:source
  :implicit`. This is the migration fallback: existing behavior is preserved
  unchanged when no project manifests exist."
  [options]
  (let [{:keys [workspace-root runs-root workflow-roots tesseraft-home]} (opts options)
        settings (coerce-settings (read-settings-file (:project (settings-paths options))))
        conn-jira (when (:jira_token settings) {:credential-ref (str "env:JIRA_TOKEN")})
        conn-github (when (:github_token settings) {:credential-ref (str "env:GITHUB_TOKEN")})
        connections (cond-> {}
                       (seq conn-jira) (assoc :jira conn-jira)
                       (seq conn-github) (assoc :github conn-github))]
    {:project_id "default"
     :name "Default"
     :workspace_root (str (abs-path workspace-root "."))
     :runs_root runs-root
     :discovery {:workflow-roots (vec workflow-roots)
                 :tesseraft-home tesseraft-home}
     :settings (let [base {:pi-default-provider (or (:pi_default_provider settings) nil)
                           :pi-default-model (or (:pi_default_model settings) nil)
                           :default-repo-root (or (:default_repo_root settings) nil)
                           :color-scheme (or (:color_scheme settings) "classic")}]
                 (-> base
                     (api-value)
                     (assoc :github-token (mask-token (:github_token settings))
                            :jira-token (mask-token (:jira_token settings)))))
     :connections connections
     :source :implicit}))

(defn- same-project-root? [options a b]
  (= (str (abs-path (:workspace-root (opts options)) a))
     (str (abs-path (:workspace-root (opts options)) b))))

(defn- agreeing-manifest-duplicate [options descriptor project-id]
  (when-let [m (read-project-manifest options project-id)]
    (let [manifest-root (or (:workspace_root m) ".")]
      (when (and (= project-id (:project_id descriptor))
                 (same-project-root? options (:workspace_root descriptor) manifest-root))
        {:source :manifest
         :project_id project-id
         :workspace_root (str (abs-path (:workspace-root (opts options)) manifest-root))}))))

(defn- project-root-exists? [options root]
  (fs/exists? (abs-path (:workspace-root (opts options)) root)))

(defn- stale-project-root-response [options project-id root]
  (error-response 409 "stale_project_root" "Registered project root is missing"
                  {:project_id project-id
                   :recorded_root (str (abs-path (:workspace-root (opts options)) root))
                   :searched_for_replacement false}))

(defn resolve-project
  "Single entry point for project resolution. If project_id is nil or the
  literal `default`, resolve the default project: prefer a persisted
  `.tesseraft/projects/default.json`; else synthesize from legacy config
  (`:source :implicit`). Any missing manifest returns 404 for an explicit id."
  ([options] (resolve-project options nil))
  ([options project-id]
   (let [pid (or project-id "default")]
     (if-let [descriptor (read-project-descriptor options)]
       (if (:error descriptor)
         descriptor
         (let [duplicate (agreeing-manifest-duplicate options descriptor pid)]
           (cond-> (assoc descriptor :source :descriptor)
             duplicate
             (assoc-in [:diagnostics :duplicates] [duplicate]))))
       (if-not (valid-project-id? pid)
         (error-response 400 "bad_request" "Invalid project_id"
                         {:project_id pid :pattern "^[a-z0-9][a-z0-9-]{0,62}$"})
         (if-let [m (read-project-manifest options pid)]
           (let [root (or (:workspace_root m) ".")]
             (if (project-root-exists? options root)
               (assoc m :source (or (:source m) :manifest) :project_id pid)
               (stale-project-root-response options pid root)))
           (if (= "default" pid)
             (synthesize-default-project options)
             (error-response 404 "not_found" "Project not found"
                             {:project_id pid}))))))))

(defn list-projects
  ([] (list-projects {}))
  ([options]
   (let [manifests (list-project-manifests options)
         has-default? (some #(= "default" (:project_id %)) manifests)]
     (if (or (seq manifests) has-default?)
       {:projects (mapv api-value manifests)}
       ;; No manifests at all: synthesize the implicit default so the list is
       ;; never empty (preserves current single-project behavior).
       {:projects [(-> (synthesize-default-project options)
                       (api-value)
                       (select-keys ["project_id" "name" "source"]))]}))))

(defn get-project
  ([] (get-project {} nil))
  ([options project-id]
   (let [resolved (resolve-project options project-id)]
     (if (:error resolved)
       resolved
;; Secrets never leave `get-project`: tokens are already masked in
;; `synthesize-default-project`; persisted manifests store only credential
;; refs (never raw tokens). Connections expose `:credential-ref` and masked
;; state only.
       (let [p resolved
             connections (into {}
                              (for [[k v] (:connections p {})]
                                [k (api-value v)]))]
         (api-value (-> p
                        (assoc :connections connections))))))))

(defn- path-escape-component?
  "True if the relative path string contains a `..` path component or an
  absolute path, i.e. could resolve outside its intended root. Accepts a
  workspace root to interpret relative vs absolute inputs."
  [workspace-root p]
  (let [parts (if (str/blank? p) [] (str/split (str p) #"/"))]
    (or (fs/absolute? (fs/path p))
        (some #(= % "..") parts))))

(defn- validate-project-spec
  "Validate a project create/update spec. Returns a string error or nil."
  [options project-id spec]
  ;; Absolutize the workspace root so confinement checks are well-defined even
  ;; when the configured `:workspace-root` is the relative default `"."`.
  ;; `abs-path` only absolutizes *its input* when it is already absolute, so a
  ;; relative workspace root would otherwise yield empty/relative `abs-path`
  ;; results and let absolute escapes (e.g. `/tmp/escape`) through.
  (let [wr (str (fs/absolutize (or (:workspace-root (opts options)) ".")))]
    (cond
      (not (valid-project-id? project-id))
      (str "Invalid project_id (expected " project-id-re ")")

      (and (contains? spec :workspace_root) (not (string? (:workspace_root spec))))
      "workspace_root must be a string"

      (and (contains? spec :runs_root) (not (string? (:runs_root spec))))
      "runs_root must be a string"

      (and (contains? spec :workspace_root)
           (not (path-prefix? (abs-path wr ".")
                             (abs-path wr (:workspace_root spec)))))
      "workspace_root must be under the current workspace"

      ;; runs_root is resolved relative to the workspace root and must stay
      ;; confined under it: reject any `..` component or absolute path outside
      ;; the workspace. This is the control-plane-level confinement that
      ;; prevents run artifacts from being written to arbitrary filesystem
      ;; locations (design §6 path-confinement risk).
      (and (contains? spec :runs_root)
           (or (path-escape-component? wr (:runs_root spec))
               (not (path-prefix? (abs-path wr ".")
                                 (abs-path wr (:runs_root spec))))))
      "runs_root must be a relative path under the current workspace"

      :else
      (let [discovery (:discovery spec)
            conn (:connections spec)]
        (cond
          (and (some? discovery) (not (map? discovery)))
          "discovery must be an object"

          (and (some? (:workflow-roots discovery))
               (or (not (sequential? (:workflow-roots discovery)))
                   (not-every? string? (:workflow-roots discovery))))
          "discovery.workflow-roots must be an array of strings"

          (and (some? (:tesseraft-home discovery))
               (not (string? (:tesseraft-home discovery))))
          "discovery.tesseraft-home must be a string"

          (and (some? conn) (not (map? conn)))
          "connections must be an object"

          :else
          (let [bad-conn (some (fn [[_k v]]
                                 (when (map? v)
                                   (when-let [r (:credential-ref v)]
                                     (when-not (credential-ref? r)
                                       (:credential-ref v)))))
                               conn)]
            (when bad-conn
              (str "Invalid credential-ref: " bad-conn))))))))

(defn create-project
  ([options project-id spec] (create-project options project-id spec false))
  ([options project-id spec _global?] ; kept for API symmetry; manifests are project-scoped
   (let [spec (or spec {})]
     (cond
       (not (valid-project-id? project-id))
       (error-response 400 "bad_request" "Invalid project_id"
                       {:project_id project-id :pattern "^[a-z0-9][a-z0-9-]{0,62}$"})

       (fs/exists? (project-manifest-path options project-id))
       (let [existing (read-project-manifest options project-id)
             existing-root (or (:workspace_root existing) ".")
             requested-root (or (:workspace_root spec)
                                (str (abs-path (:workspace-root (opts options)) ".")))
             re-registration? (and existing
                                   (= "registration" (:source spec))
                                   (= "registration" (:source existing)))]
         (cond
           (and re-registration? (same-project-root? options existing-root requested-root))
           (get-project options project-id)

           (and re-registration? (not (project-root-exists? options existing-root)))
           (do
             (fs/delete-if-exists (project-manifest-path options project-id))
             (create-project options project-id spec _global?))

           :else
           (error-response 409 "conflict" "A project with that id already exists"
                           {:project_id project-id})))

       :else
       (if-let [err (validate-project-spec options project-id spec)]
         (error-response 400 "bad_request" err)
         (let [name (or (:name spec) project-id)
               manifest (cond->
                          {:project_id project-id
                           :name name
                           :workspace_root (or (:workspace_root spec)
                                               (str (abs-path (:workspace-root (opts options)) ".")))
                           :runs_root (or (:runs_root spec) (:runs-root (opts options)))
                           :discovery (or (:discovery spec)
                                          {:workflow-roots (:workflow-roots (opts options))
                                           :tesseraft-home (:tesseraft-home (opts options))})}
                          (:source spec) (assoc :source (:source spec))
                          (seq (:settings spec)) (assoc :settings (:settings spec))
                          (seq (:connections spec)) (assoc :connections (:connections spec)))
               target (project-manifest-path options project-id)]
           (fs/create-dirs (fs/parent target))
           (store/write-json! target manifest)
           (get-project options project-id)))))))

(defn update-project
  ([options project-id spec] (update-project options project-id spec false))
  ([options project-id spec _global?]
   (let [spec (or spec {})]
     (cond
       (not (valid-project-id? project-id))
       (error-response 400 "bad_request" "Invalid project_id"
                       {:project_id project-id :pattern "^[a-z0-9][a-z0-9-]{0,62}$"})

       (not (fs/exists? (project-manifest-path options project-id)))
       (error-response 404 "not_found" "Project not found" {:project_id project-id})

       :else
       (if-let [err (validate-project-spec options project-id spec)]
         (error-response 400 "bad_request" err)
         (let [current (or (read-project-manifest options project-id) {})
               merged (merge current spec)]
           (store/write-json! (project-manifest-path options project-id) merged)
           (get-project options project-id)))))))

(defn migrate-project
  "Write the synthesized default project to `.tesseraft/projects/default.json`,
  stamped with `:migrated-from :legacy-settings`. Legacy files are NOT deleted
  in this phase (read-only fallback remains)."
  ([options] (migrate-project options "default"))
  ([options project-id]
   (let [pid (or project-id "default")]
     (cond
       (not (= "default" pid))
       (error-response 400 "bad_request" "Only the default project can be migrated in this phase")

       (fs/exists? (project-manifest-path options pid))
       (error-response 409 "conflict" "Default project already exists; remove the manifest to re-migrate"
                       {:project_id pid})

       :else
       (let [synth (synthesize-default-project options)
             manifest (-> synth
                         (dissoc :source)
                         (assoc :migrated-from :legacy-settings))
             target (project-manifest-path options pid)]
         (fs/create-dirs (fs/parent target))
         (store/write-json! target manifest)
         (get-project options pid))))))

(defn mask-credential
  "Resolve a credential-ref against the out-of-repo store and return a masked
  state (present/absent) WITHOUT ever returning the raw token. `env:` refs are
  resolved from the process environment; `github-actions:` refs are validated
  but not resolved locally (reported as :unresolved)."
  [options ref]
  (cond
    (or (nil? ref) (str/blank? (str ref))) {:present false}
    (not (credential-ref? ref)) {:present false :error "invalid credential-ref"}
    :else
    (let [[_ store-name path] (re-matches credential-ref-re ref)]
      (case store-name
        "env"
        (let [v (System/getenv path)]
          (if (str/blank? v)
            {:present false :credential-ref ref}
            {:present true :credential-ref ref :preview (subs v (max 0 (- (count v) 4)))}))
        "github-actions"
        {:present false :credential-ref ref :unresolved "github-actions store not wired for local resolution"}
        {:present false :credential-ref ref :unresolved (str "unknown store: " store-name)}))))

(defn get-project-connections
  ([] (get-project-connections {} nil))
  ([options project-id]
   (let [resolved (resolve-project options project-id)]
     (if (:error resolved)
       resolved
       (let [creds (or (read-credentials options) {})]
         {:connections
          (into {} (for [[k v] (:connections resolved {})]
                     (let [ref (:credential-ref v)
                           masked (if (and ref (get creds (str ref)))
                                    {:present true :credential-ref ref}
                                    (mask-credential options ref))]
                       [k (api-value (merge v {:credential-state masked}))])))})))))

(defn update-project-connections
  ([] (update-project-connections {} nil nil))
  ([options project-id updates]
   (let [updates (or updates {})]
     (cond
       (not (map? updates))
       (error-response 400 "bad_request" "connections update must be an object")

       (some (fn [[_ v]]
               (and (map? v)
                    (some #(contains? v %) [:token :github_token :jira_token :secret :password])))
             updates)
       ;; Raw token payloads are NEVER accepted; only refs + base-url.
       (error-response 400 "bad_request"
                      "Raw token payloads are not accepted; provide a credential-ref instead")

       :else
       (let [resolved (resolve-project options project-id)]
         (if (:error resolved)
           resolved
           (let [bad-ref (some (fn [[_k v]]
                                 (when (and (map? v) (:credential-ref v))
                                   (when-not (credential-ref? (:credential-ref v))
                                     (:credential-ref v))))
                               updates)]
             (if bad-ref
               (error-response 400 "bad_request" (str "Invalid credential-ref: " bad-ref))
               (let [current (or (read-project-manifest options (or project-id "default"))
                                (-> (synthesize-default-project options)
                                    (dissoc :source)))
                     merged-conn (merge (:connections current {}) updates)
                     manifest (assoc current :connections merged-conn)
                     target (project-manifest-path options (or project-id "default"))]
                 (fs/create-dirs (fs/parent target))
                 (store/write-json! target manifest)
                 (get-project-connections options project-id))))))))))

(defn discovery-roots
  "Discover workflow/package roots with precedence `configured < global <
  project`. Optional `project-id` threads the resolved project's
  `workspace-root`/`discovery` so project-scoped discovery is honored; the
  1-arity form keeps existing behavior by resolving the default project."
  ([options kind] (discovery-roots options kind nil))
  ([options kind project-id]
   (let [project (resolve-project options project-id)
         resolved (if (:error project)
                    ;; Unresolvable project id: fall back to defaults so a
                    ;; missing manifest never breaks discovery (defensive).
                    (opts options)
                    project)
         workspace-root (or (:workspace_root resolved) (:workspace-root (opts options)))
         workflow-roots (or (get-in resolved [:discovery :workflow-roots])
                            (:workflow-roots (opts options)))
         home (or (get-in resolved [:discovery :tesseraft-home])
                  (:tesseraft-home (opts options)))
         root-name (name kind)]
     (vec
       (concat
         (map-indexed
           (fn [idx root]
             {:root (abs-path workspace-root root)
              :source :configured
              :precedence idx})
           workflow-roots)
         [{:root (fs/path (tesseraft-home options) root-name)
           :source :global
           :precedence 100}
          {:root (abs-path workspace-root (fs/path ".tesseraft" root-name))
           :source :project
           :precedence 200}])))))

(defn package-files [options kind file-name]
  (->> (discovery-roots options kind)
       (mapcat (fn [{:keys [root source precedence]}]
                 (when (fs/exists? root)
                   (for [p (file-seq (fs/file root))
                         :when (and (.isFile p) (= file-name (.getName p)))]
                     {:file (fs/path p)
                      :source source
                      :precedence precedence}))))
       (remove nil?)
       (sort-by (juxt :precedence (comp str :file)))
       vec))

(defn workflow-files [options]
  (mapv :file (package-files options :workflows "workflow.edn")))

(defn workflow-file-entries [options]
  (package-files options :workflows "workflow.edn"))

;; Fragment packages live under .tesseraft/fragments/<name>/fragment.edn,
;; ~/.tesseraft/fragments/<name>/fragment.edn, and
;; examples/fragments/<name>/fragment.edn, using the same generic
;; discovery-roots/package-files helpers.
(defn fragment-file-entries [options]
  (package-files options :fragments "fragment.edn"))

(defn fragment-files [options]
  (mapv :file (fragment-file-entries options)))

(defn fragment-candidates [options name]
  (->> (fragment-file-entries options)
       (keep (fn [p]
               (try
                 (let [pkg (spec/read-fragment-package (:file p))]
                   (when (= (str name) (str (spec/fragment-package-name pkg)))
                     {:file (:file p)
                      :source (:source p)
                      :precedence (:precedence p)
                      :fragment pkg}))
                 (catch Throwable _ nil))))
       vec))

(defn resolve-fragment [options name]
  (let [matches (fragment-candidates options name)
        max-precedence (when (seq matches) (apply max (map :precedence matches)))
        visible-matches (filter #(= max-precedence (:precedence %)) matches)]
    (cond
      (empty? visible-matches) (error-response 404 "not_found" "Fragment package not found" {:name name})
      (> (count visible-matches) 1) (error-response 409 "conflict" "Multiple fragment packages share this name"
                                                    {:name name :paths (mapv #(relative-path (:workspace-root (opts options)) (:file %)) visible-matches)})
      :else (first visible-matches))))

(defn lint-summary [lint-result]
  {:ok (:ok lint-result)
   :errors (count (:errors lint-result))
   :warnings (count (:warnings lint-result))})

(defn read-workflow-entry [options workflow-entry]
  (let [{:keys [workspace-root]} (opts options)
        workflow-file (if (map? workflow-entry) (:file workflow-entry) workflow-entry)
        source (if (map? workflow-entry) (:source workflow-entry) :configured)
        precedence (when (map? workflow-entry) (:precedence workflow-entry))
        lint-result (lint/lint-file workflow-file)]
    (try
      (let [wf (spec/read-workflow workflow-file)]
        (cond-> {:name (str (spec/workflow-name wf))
                 :path (relative-path workspace-root workflow-file)
                 :source source
                 :api_version (:api-version wf)
                 :lint (lint-summary lint-result)}
          (some? precedence) (assoc :precedence precedence)))
      (catch Throwable t
        (cond-> {:name nil
                 :path (relative-path workspace-root workflow-file)
                 :source source
                 :api_version nil
                 :lint (lint-summary lint-result)
                 :error {:code "parse_error" :message (.getMessage t)}}
          (some? precedence) (assoc :precedence precedence))))))

(defn entry-name [entry]
  (try
    (str (spec/workflow-name (spec/read-workflow (:file entry))))
    (catch Throwable _ nil)))

(defn select-visible-workflow-entries [entries]
  (->> entries
       (group-by entry-name)
       (mapcat (fn [[name same-name]]
                 (if (nil? name)
                   same-name
                   (let [max-precedence (apply max (map :precedence same-name))]
                     (filter #(= max-precedence (:precedence %)) same-name)))))
       (sort-by (juxt (comp str entry-name) (comp str :file)))
       vec))

(defn workflow-meta-item
  "Compact, UI-facing record of a same-name workflow entry used to describe
  shadowing/conflict relationships. `scope` is the stringified discovery source
  (configured/global/project); kept distinct from the outer entry's `source`
  field name to match the design contract (outer keeps `source`, shadowing
  lists use `scope`)."
  [workspace-root entry]
  {:scope (name (:source entry))
   :path (relative-path workspace-root (:file entry))
   :precedence (:precedence entry)})

(defn shadowing-for-visible
  "Compute purely-inspectable shadowing metadata for each *visible* workflow
  entry without altering precedence/selection semantics. For a visible entry
  `v` with name `n` and precedence `p`:
    - `conflicts`   = other same-name entries at equal precedence `p`
                     (the ambiguous case resolve-workflow 409s on; surfaced
                     here so the list endpoint can show *why* without a resolve).
    - `duplicates`  = other same-name entries at strictly lower precedence
                     (entries this one overrides/shadows).
  Returns a map from the entry's file path (string) to its metadata.
  Grouping reuses `entry-name` (the same reader the unchanged
  `select-visible-workflow-entries` uses), so the visible set is exactly what
  `select-visible-workflow-entries` already returns — nothing about precedence
  selection changes here."
  [options entries visible]
  (let [{:keys [workspace-root]} (opts options)
        by-name (group-by entry-name entries)]
    (into {}
      (for [v visible
            :let [name (entry-name v)
                  same-name (get by-name name)
                  self-file (:file v)
                  prec (:precedence v)
                  others (remove #(= (:file %) self-file) same-name)
                  conflicts (mapv #(workflow-meta-item workspace-root %)
                                  (filter #(= (:precedence %) prec) others))
                  duplicates (mapv #(workflow-meta-item workspace-root %)
                                   (filter #(< (:precedence %) prec) others))]]
        [(str self-file)
         (cond-> {:precedence prec}
           (seq conflicts) (assoc :conflicts conflicts)
           (seq duplicates) (assoc :duplicates duplicates))]))))

(defn project-scoped-opts
  "Build per-call options resolved from a project. The project's
  `:workspace_root`/`:runs_root`/discovery roots are relative to the control
  workspace (where project manifests live), so `:workspace_root` is resolved
  against `(:workspace-root opts)` via `abs-path` — never replaced with a
  bare relative path that would silently relocate discovery to the process
  cwd. `:runs_root` stays relative (resolved by `run-state-files` against
  the now-absolutized workspace root). If the project can't be resolved,
  returns `opts` unchanged (defensive fallback). The `default` project's
  `workspace_root` is `.` (the control workspace), preserving existing
  single-project behavior."
  ([options] (project-scoped-opts options nil))
  ([options project-id]
   (let [project (resolve-project options project-id)]
     (if (:error project)
       (if (= "invalid_project_descriptor" (get-in project [:error :code]))
         project
         (opts options))
       (let [control-ws (:workspace-root (opts options))]
         (-> (opts options)
             (assoc :workspace-root (str (abs-path control-ws (:workspace_root project)))
                    :runs-root (:runs_root project))
             (assoc :workflow-roots (or (get-in project [:discovery :workflow-roots])
                                       (:workflow-roots (opts options)))
                    :tesseraft-home (or (get-in project [:discovery :tesseraft-home])
                                        (:tesseraft-home (opts options))))))))))

(defn list-workflows
  ([] (list-workflows {}))
  ([options] (list-workflows options nil))
  ([options project-id]
   (let [sopts (project-scoped-opts options project-id)]
     (if (:error sopts)
       sopts
       (let [entries (workflow-file-entries sopts)
             visible (select-visible-workflow-entries entries)
             meta (shadowing-for-visible sopts entries visible)]
         {:workflows
          (mapv (fn [v]
                  (api-value
                    (merge (read-workflow-entry sopts v)
                           (get meta (str (:file v))))))
                visible)})))))

(defn workflow-candidates [options name]
  (->> (workflow-file-entries options)
       (keep (fn [p]
               (try
                 (let [wf (spec/read-workflow (:file p))]
                   (when (= (str name) (str (spec/workflow-name wf)))
                     {:file (:file p)
                      :source (:source p)
                      :precedence (:precedence p)
                      :workflow wf}))
                 (catch Throwable _ nil))))
       vec))

(defn resolve-workflow [options name]
  (let [matches (workflow-candidates options name)
        max-precedence (when (seq matches) (apply max (map :precedence matches)))
        visible-matches (filter #(= max-precedence (:precedence %)) matches)]
    (cond
      (empty? visible-matches) (error-response 404 "not_found" "Workflow not found" {:name name})
      (> (count visible-matches) 1) (error-response 409 "conflict" "Multiple workflows share this name"
                                                    {:name name :paths (mapv #(relative-path (:workspace-root (opts options)) (:file %)) visible-matches)})
      :else (first visible-matches))))

(defn get-workflow
  ([] (get-workflow {} nil nil))
  ([options name] (get-workflow options name nil))
  ([options name project-id]
   (let [sopts (project-scoped-opts options project-id)
         resolved (resolve-workflow sopts name)]
     (if (:error resolved)
       resolved
       (let [{:keys [workspace-root]} sopts
             {:keys [file workflow source precedence]} resolved
             lint-result (lint/lint-file file)
             ;; Shadowing context for the detail view. `resolve-workflow`
             ;; already 409s on an equal-precedence conflict, so when we
             ;; get here the resolution is unique: `conflicts` is therefore
             ;; empty in practice (kept for symmetry with the list endpoint)
             ;; and `duplicates` lists the lower-precedence same-name entries
             ;; this workflow overrides. Precedence/selection semantics are
             ;; untouched — this only attaches inspection metadata.
             matches (workflow-candidates sopts name)
             others (remove #(= (:file %) file) matches)
             conflicts (mapv #(workflow-meta-item workspace-root %)
                             (filter #(= (:precedence %) precedence) others))
             duplicates (mapv #(workflow-meta-item workspace-root %)
                              (filter #(< (:precedence %) precedence) others))]
         (api-value
           (cond-> {:workflow {:name (str (spec/workflow-name workflow))
                               :path (relative-path workspace-root file)
                               :source source
                               :precedence precedence
                               :api_version (:api-version workflow)
                               :normalized (dissoc workflow :__file :__dir)
                               :lint lint-result}}
             (seq conflicts) (assoc-in [:workflow :conflicts] conflicts)
             (seq duplicates) (assoc-in [:workflow :duplicates] duplicates))))))))

(defn edge-from-transition [from tr]
  (cond-> {:from (spec/normalize-id from)
           :to (spec/normalize-id (:next tr))}
    (:when tr) (assoc :condition (:when tr))
    (:effects tr) (assoc :effects (:effects tr))))

(defn get-workflow-graph
  ([] (get-workflow-graph {} nil nil))
  ([options name] (get-workflow-graph options name nil))
  ([options name project-id]
   (let [sopts (project-scoped-opts options project-id)
         resolved (resolve-workflow sopts name)]
     (if (:error resolved)
       resolved
       (let [{:keys [file workflow]} resolved
             lint-result (lint/lint-file file)]
         (api-value
           {:workflow_name (str (spec/workflow-name workflow))
            :nodes (vec (for [[id node] (:states workflow)]
                          (cond-> {:id (spec/normalize-id id)
                                   :type (:type node)}
                            (:title node) (assoc :title (:title node))
                            (:outputs node) (assoc :outputs (:outputs node))
                            (:resources node) (assoc :resources (:resources node)))))
            :edges (vec (for [[from node] (:states workflow)
                              tr (spec/transitions node)
                              :when (:next tr)]
                          (edge-from-transition from tr)))
            :diagnostics (:diagnostics lint-result)}))))))

(defn run-state-files
  ([options] (run-state-files options nil))
  ([options project-id]
   (let [sopts (project-scoped-opts options project-id)
         {:keys [workspace-root runs-root]} sopts
         root (abs-path workspace-root runs-root)]
     (if-not (fs/exists? root)
       []
       (->> (for [p (file-seq (fs/file root))
                  :when (and (.isFile p) (= "state.edn" (.getName p)))]
              (fs/path p))
            (sort-by str)
            vec)))))

(defn run-dir-from-state-file [state-file]
  (fs/parent state-file))

(defn staleness-threshold-seconds
  "Configurable staleness threshold (seconds). Default 120s. Override with the
  TESSERAFT_STALE_THRESHOLD_SECONDS environment variable. Kept out of CLI
  arg parsing to avoid breaking existing callers."
  []
  (or (some-> (System/getenv "TESSERAFT_STALE_THRESHOLD_SECONDS")
              (parse-long)
              (#(when (and % (pos? %)) %)))
      120))

(defn ^:private parse-instant
  ^java.time.Instant [s]
  (when (and s (string? s))
    (try (java.time.Instant/parse s) (catch Throwable _ nil))))

(defn seconds-since
  "Whole seconds between an ISO-8601 timestamp and now, or nil if unparseable."
  [s]
  (when-let [t (parse-instant s)]
    (.getSeconds (java.time.Duration/between t (java.time.Instant/now)))))

(defn latest-event-at
  "Return the :at timestamp of the last event in the append-only events list, or
  nil when there are no events. Events are written by the runtime on every
  transition (node.started/finished/failed/orphaned, transition.selected,
  effect.applied, run.*) with an :at timestamp, so the newest event is a fresh
  heartbeat of run activity independent of state.edn's :updated-at (which is
  only bumped on transitions, not while a subprocess is executing)."
  [events]
  (when (seq events)
    (:at (last events))))

(defn- newest-timestamp
  "Given a collection of ISO-8601 timestamp strings, return the one that
  parses to the latest java.time.Instant (the original string is preserved so
  downstream string-consuming helpers like seconds-since still work). Returns
  nil if none parse."
  [ts]
  (let [pairs (keep (fn [s] (when-let [i (parse-instant s)] [i s])) ts)]
    (when (seq pairs)
      (->> pairs
           (reduce (fn [[best-i best-s] [i s]]
                     (if (or (nil? best-i) (.isAfter i best-i)) [i s] [best-i best-s]))
                   [nil nil])
           second))))

(defn derive-liveness
  "Additive, read-only heuristic liveness for a run. Returns a map with
  :liveness (one of done/failed/cancelled/orphaned/stale/executing/parked) and
  :staleness_seconds. attempts may be empty for a cheap derivation; an empty
  attempts seq means we cannot see an in-flight node, so a fresh running run is
  reported as parked and a stale one as stale (acceptable for the Runs list).
  The full get-run path supplies real attempts so orphaned/executing are
  distinguished.

  Optional :last-activity-at (an ISO-8601 timestamp) overrides/augments the
  summary's :updated_at for staleness. The detail path (get-run/delete-run)
  passes max(:updated_at, latest-event-at) here so a long-running node that is
  actively emitting events is not marked stale/orphaned merely because
  state.edn's :updated-at (bumped only on node transitions) is older than the
  threshold. This preserves the fail-fast orphan intent: a wedged node stops
  emitting events and still trips the threshold → orphaned."
  ([summary attempts] (derive-liveness summary attempts nil))
  ([summary attempts opts]
   (let [status (:status summary)
         state-name (when (:state summary) (name (:state summary)))
         non-terminal (not (#{"done" "failed" "error" "cancelled"} (str status)))
         last-activity (:last-activity-at opts)
         activity-ts (when non-terminal
                      (if last-activity
                        (or (newest-timestamp [(:updated_at summary) last-activity])
                            (:updated_at summary))
                        (:updated_at summary)))
         staleness-s (when non-terminal (seconds-since activity-ts))
         threshold (staleness-threshold-seconds)
         stale? (and staleness-s (>= staleness-s threshold))
         current-running (when (and non-terminal state-name (seq attempts))
                          (->> attempts
                               (filter #(and (= state-name (str (:state %)))
                                             (= "running" (:status %))))
                               first))]
     {:liveness
      (cond
        (= "done" (str status)) "done"
        (= "cancelled" (str status)) "cancelled"
        (#{"failed" "error"} (str status)) "failed"
        current-running (if stale? "orphaned" "executing")
        stale? "stale"
        :else "parked")
      :staleness_seconds staleness-s})))

(defn run-summary [options state-file]
  (let [{:keys [workspace-root]} (opts options)
        ctx (store/load-context (run-dir-from-state-file state-file))
        run (:run ctx)
        workflow (:workflow ctx)
        summary {:run_id (or (:id run) (str (fs/file-name (run-dir-from-state-file state-file))))
                 :project_id (or (:project-id run) "default")
                 :workflow_name (:name workflow)
                 :workflow_version (:version workflow)
                 :state (:state run)
                 :status (:status run)
                 :round (:round run)
                 :attempt (:attempt run)
                 :created_at (:created-at run)
                 :updated_at (:updated-at run)
                 :path (relative-path workspace-root (run-dir-from-state-file state-file))}
        ;; Cheap liveness for the Runs list: no attempts are derived here
        ;; (derive-attempts-from-events is defined later in this namespace and
        ;; babashka resolves defn-body symbols eagerly, so a forward reference
        ;; would fail). Empty attempts yields done/failed/stale/parked, which is
        ;; enough to surface dead/stale runs in the list (ISSUE 4). The detail
        ;; endpoint get-run recomputes liveness with real attempts to add
        ;; orphaned/executing.
        liveness (derive-liveness summary [])]
    (merge summary liveness)))

(defn list-runs
  ([] (list-runs {}))
  ([options] (list-runs options nil))
  ([options project-id]
   (let [sopts (project-scoped-opts options project-id)
         entries (mapv (fn [state-file]
                         (try
                           {:run (api-value (run-summary sopts state-file))}
                           (catch Throwable t
                             {:error {:code "parse_error"
                                      :message (.getMessage t)
                                      :details {:path (relative-path (:workspace-root sopts) state-file)}}})))
                       (run-state-files options project-id))]
     {:runs (mapv :run (filter :run entries))
      :errors (mapv :error (filter :error entries))})))

(defn matching-run-files
  ([options run-id] (matching-run-files options run-id nil))
  ([options run-id project-id]
   (let [pid (or project-id "default")]
     (->> (run-state-files options project-id)
          (keep (fn [state-file]
                  (try
                    (let [ctx (store/load-context (run-dir-from-state-file state-file))
                          recorded-id (get-in ctx [:run :id])
                          dir-id (str (fs/file-name (run-dir-from-state-file state-file)))
                          id-match? (or (= (str run-id) (str recorded-id))
                                        (= (str run-id) dir-id))
                          ;; Run identity is (project_id, run_id): a run matches
                          ;; only when its recorded :project-id equals the
                          ;; requested project, OR the run predates project
                          ;; stamping and the request is for the default project.
                          ;; This lets two projects share the same run_id without
                          ;; colliding even when they share a runs-root.
                          recorded-pid (get-in ctx [:run :project-id])
                          pid-match? (or (= pid (str recorded-pid))
                                        (and (nil? recorded-pid)
                                             (= "default" pid)))]
                      (when (and id-match? pid-match?)
                        {:state-file state-file :run-dir (run-dir-from-state-file state-file) :context ctx}))
                  (catch Throwable _ nil))))
          vec))))

(defn resolve-run
  ([options run-id] (resolve-run options run-id nil))
  ([options run-id project-id]
   (let [pid (or project-id "default")
         sopts (project-scoped-opts options project-id)
         matches (matching-run-files options run-id project-id)]
     (cond
       (empty? matches) (error-response 404 "not_found" "Run not found" {:run_id run-id :project_id pid})
       (> (count matches) 1) (error-response 409 "conflict" "Multiple runs share this run id"
                                             {:run_id run-id
                                              :paths (mapv #(relative-path (:workspace-root sopts) (:run-dir %)) matches)})
       :else (first matches)))))

(defn events-file [run-dir]
  (fs/path run-dir "events.jsonl"))

(defn read-events-file [p]
  (if-not (fs/exists? p)
    []
    (let [lines (str/split-lines (slurp (str p)))]
      (loop [idx 1 xs lines acc []]
        (if-let [line (first xs)]
          (if (str/blank? line)
            (recur (inc idx) (rest xs) acc)
            (let [parsed (try
                           (json/parse-string line true)
                           (catch Throwable t
                             (reduced (error-response 422 "parse_error" "Malformed event JSONL line"
                                                      {:line idx :message (.getMessage t)}))))]
              (if (reduced? parsed)
                @parsed
                (recur (inc idx) (rest xs) (conj acc parsed)))))
          acc)))))

(defn event-name [event]
  (or (:event event) (:type event)))

(defn nonzero-exit-code? [result]
  (let [exit-code (:exit-code result)]
    (and (number? exit-code) (not (zero? exit-code)))))

(defn result-error? [result]
  (and result
       (or (= "error" (:status result))
           (= false (:ok result))
           (nonzero-exit-code? result))))

(defn result-error-summary [result]
  (when (result-error? result)
    (or (:message result)
        (:error result)
        (:stderr result)
        (when (nonzero-exit-code? result) (str "exit code " (:exit-code result)))
        (when (= "error" (:status result)) "result status error"))))

(defn attempt-status [finished? result]
  (cond
    (result-error? result) "error"
    finished? "ok"
    :else "running"))

(defn derive-attempts-from-events [events]
  (loop [events events active {} acc []]
    (if-let [event (first events)]
      (let [name (event-name event)]
        (case name
          "node.started"
          (let [attempt (or (:attempt event) (inc (count acc)))
                state (:state event)]
            (recur (rest events)
                   (assoc active state {:attempt attempt
                                        :node_id state
                                        :state state
                                        :started_at (:at event)
                                        :status "running"})
                   acc))
          "node.finished"
          (let [state (:state event)
                current (or (get active state) {:attempt (inc (count acc)) :node_id state :state state})
                result (:result event)
                attempt (assoc current
                               :finished_at (:at event)
                               :status (attempt-status true result)
                               :result result)
                attempt (cond-> attempt
                          (result-error-summary result) (assoc :error (result-error-summary result)))]
            (recur (rest events) (dissoc active state) (conj acc attempt)))
          "node.failed"
          (let [state (:state event)
                current (or (get active state) {:attempt (or (:attempt event) (inc (count acc))) :node_id state :state state})
                result (:result event)
                attempt (cond-> (assoc current
                                       :finished_at (:at event)
                                       :status "error"
                                       :result result)
                          (or (:error event) (result-error-summary result))
                          (assoc :error (or (:error event) (result-error-summary result))))]
            (recur (rest events) (dissoc active state) (conj acc attempt)))
          "node.orphaned"
          (let [state (:state event)
                current (or (get active state) {:attempt (or (:attempt event) (inc (count acc))) :node_id state :state state})
                attempt (cond-> (assoc current
                                       :finished_at (:at event)
                                       :status "error"
                                       :result (:result event))
                          (or (:error event) "orphaned")
                          (assoc :error (or (:error event) "orphaned")))]
            (recur (rest events) (dissoc active state) (conj acc attempt)))
          "transition.selected"
          (let [from (:from event)]
            (recur (rest events)
                   active
                   (mapv (fn [attempt]
                           (if (= (:state attempt) from)
                             (assoc attempt :next_state (:to event) :effects (:effects event))
                             attempt)) acc)))
          (recur (rest events) active acc)))
      (vec (concat acc (vals active))))))

(defn attempts-from-context [ctx events]
  (let [explicit (or (:attempts ctx) (get-in ctx [:run :attempts]))]
    (if (seq explicit)
      explicit
      (derive-attempts-from-events events))))

(def preview-limit (* 64 1024))
(def scan-file-limit 250)
(def max-read-size (* 1024 1024))

(defn reject-artifact-path [p]
  (cond
    (str/blank? (str p)) (error-response 400 "bad_request" "Artifact path is required")
    (fs/absolute? (fs/path p)) (error-response 403 "forbidden" "Absolute artifact paths are not readable")
    (some #{".."} (str/split (str p) #"/")) (error-response 403 "forbidden" "Parent path traversal is not allowed")
    :else nil))

(defn path-starts-with? [child parent]
  (.startsWith (.normalize child) (.normalize parent)))

(defn safe-artifact-path [run-dir rel-path]
  (if-let [err (reject-artifact-path rel-path)]
    err
    (let [base (.toRealPath (.toPath (fs/file run-dir)) (make-array java.nio.file.LinkOption 0))
          candidate (.normalize (.resolve base (str rel-path)))]
      (if-not (path-starts-with? candidate base)
        (error-response 403 "forbidden" "Artifact path escapes the run directory")
        {:path candidate :base base :rel (str rel-path)}))))

(defn existing-safe-file [run-dir rel-path]
  (let [resolved (safe-artifact-path run-dir rel-path)]
    (if (:error resolved)
      resolved
      (let [p (:path resolved)]
        (cond
          (not (java.nio.file.Files/exists p (make-array java.nio.file.LinkOption 0)))
          (assoc resolved :exists false)
          (java.nio.file.Files/isDirectory p (make-array java.nio.file.LinkOption 0))
          (error-response 400 "bad_request" "Artifact path is a directory")
          :else
          (let [real (.toRealPath p (make-array java.nio.file.LinkOption 0))]
            (if-not (path-starts-with? real (:base resolved))
              (error-response 403 "forbidden" "Artifact symlink escapes the run directory")
              (assoc resolved :path real :exists true))))))))

(defn rel-from-run [run-dir p]
  (str (fs/relativize (fs/path run-dir) (fs/path p))))

(defn content-type [path]
  (case (str/lower-case (or (fs/extension (str path)) ""))
    "json" "application/json"
    "jsonl" "application/x-jsonlines"
    "edn" "application/edn"
    "md" "text/markdown"
    "txt" "text/plain"
    "log" "text/plain"
    "text/plain"))

(defn previewable? [artifact]
  (and (:exists artifact)
       (<= (or (:size artifact) 0) preview-limit)
       (#{"application/json" "application/x-jsonlines" "application/edn" "text/markdown" "text/plain"} (:content_type artifact))))

(defn artifact-meta [run-dir rel-path source extra]
  (let [safe (safe-artifact-path run-dir rel-path)
        p (:path safe)
        exists (and (not (:error safe)) (java.nio.file.Files/exists p (make-array java.nio.file.LinkOption 0)))
        file? (and exists (not (java.nio.file.Files/isDirectory p (make-array java.nio.file.LinkOption 0))))
        real (when file? (try (.toRealPath p (make-array java.nio.file.LinkOption 0)) (catch Throwable _ nil)))
        escaped? (and real (not (path-starts-with? real (:base safe))))]
    (merge {:path (str rel-path)
            :name (str (fs/file-name (fs/path rel-path)))
            :source source
            :exists (and file? (not escaped?))
            :size (when (and file? (not escaped?)) (java.nio.file.Files/size real))
            :modified_at (when (and file? (not escaped?)) (str (java.nio.file.Files/getLastModifiedTime real (make-array java.nio.file.LinkOption 0))))
            :content_type (content-type rel-path)
            :read_url (str "?path=" (java.net.URLEncoder/encode (str rel-path) "UTF-8"))}
           extra)))

(defn declared-output-artifacts [ctx run-dir]
  (try
    (let [wf (spec/read-workflow (get-in ctx [:workflow :file]))]
      (vec (for [[state-id node] (:states wf)
                 [out-key out-path] (spec/outputs-with-paths node)
                 :let [rendered (spec/render-template-string out-path ctx)]
                 :when (and rendered (not (str/blank? rendered)) (not (fs/absolute? (fs/path rendered))))]
             (artifact-meta run-dir rendered "declared_output"
                            {:node_id (spec/normalize-id state-id) :kind (name out-key)}))))
    (catch Throwable _ [])))

(def artifact-key-regex #"(?i)(^|[-_])(file|path|artifact|log)([-_]|$)")

(defn artifact-path-values [x]
  (cond
    (map? x) (mapcat (fn [[k v]]
                       (cond
                         (and (string? v) (re-find artifact-key-regex (name k))) [v]
                         (or (map? v) (sequential? v)) (artifact-path-values v)
                         :else [])) x)
    (sequential? x) (mapcat artifact-path-values x)
    :else []))

(defn run-relative-string [run-dir s]
  (let [s (str s)
        run-dir-str (str (fs/normalize run-dir))]
    (cond
      (str/starts-with? s run-dir-str) (rel-from-run run-dir s)
      (not (fs/absolute? (fs/path s))) s
      :else nil)))

(defn event-artifacts [events run-dir]
  (->> events
       (mapcat (fn [event]
                 (for [p (artifact-path-values event)
                       :let [rel (run-relative-string run-dir p)]
                       :when (and rel (not (reject-artifact-path rel)))]
                   (artifact-meta run-dir rel "event"
                                  {:node_id (or (:state event) (:from event))
                                   :attempt (:attempt event)}))))
       vec))

(defn scan-artifacts [run-dir]
  (let [roots ["state.edn" "events.jsonl" "issues.json" "logs" "prompts/generated" "attempts"]]
    (->> roots
         (mapcat (fn [root]
                   (let [p (fs/path run-dir root)]
                     (when (fs/exists? p)
                       (if (fs/directory? p)
                         (take scan-file-limit (filter #(.isFile %) (file-seq (fs/file p))))
                         [p])))))
         (remove nil?)
         (take scan-file-limit)
         (mapv #(artifact-meta run-dir (rel-from-run run-dir %) "run_dir" {})))))

(defn dedupe-artifacts [artifacts]
  (->> artifacts
       (group-by :path)
       (mapv (fn [[_ xs]] (apply merge xs)))
       (sort-by :path)
       vec))

(defn list-artifacts* [ctx run-dir events]
  (dedupe-artifacts (concat (declared-output-artifacts ctx run-dir)
                            (event-artifacts events run-dir)
                            (scan-artifacts run-dir))))

(defn get-run-artifacts
  ([] (get-run-artifacts {} nil nil))
  ([options run-id] (get-run-artifacts options run-id nil))
  ([options run-id project-id]
   (let [resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (let [events (read-events-file (events-file (:run-dir resolved)))]
         (if (:error events)
           events
           (api-value {:run_id run-id :artifacts (list-artifacts* (:context resolved) (:run-dir resolved) events)})))))))

(defn read-run-artifact
  ([] (read-run-artifact {} nil nil nil))
  ([options run-id artifact-path] (read-run-artifact options run-id artifact-path nil))
  ([options run-id artifact-path project-id]
   (let [resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (let [safe (existing-safe-file (:run-dir resolved) artifact-path)]
         (cond
           (:error safe) safe
           (not (:exists safe)) (error-response 404 "not_found" "Artifact not found" {:path artifact-path})
           :else (let [meta (artifact-meta (:run-dir resolved) artifact-path "read" {})
                       size (:size meta)]
                   (cond
                     (> size max-read-size) (api-value {:artifact meta :previewable false :reason "file too large"})
                     (not (previewable? meta)) (api-value {:artifact meta :previewable false :reason "binary or unsupported content type"})
                     :else (api-value {:artifact meta :previewable true :content (slurp (str (:path safe)))})))))))))

(defn issues-artifact-has-issues?
  "True if the issues JSON artifact at `rel-path` under `run-dir` actually
  contains issues, false otherwise. The initial issues.json is an empty array
  `[]` written at run start by runtime.store/ensure-run-dirs!; its existence
  therefore does NOT indicate a problem during a healthy run. Only flag a failure
  here when the parsed content indicates real issues: a non-empty sequence, or a
  map whose :issues (or top-level) field is a non-empty sequence. Empty arrays,
  empty maps, null/missing, unparseable, or oversized files are NOT failures.
  Bounded by max-read-size to avoid reading huge artifacts in this hot path."
  [run-dir rel-path]
  (when (and run-dir rel-path (not (str/blank? (str rel-path))))
    (try
      (let [safe (existing-safe-file run-dir rel-path)]
        (when (and (not (:error safe)) (:exists safe))
          ;; existing-safe-file already rejects directories/traversal/symlink
          ;; escapes; reuse its path resolution and existence check.
          (let [p (:path safe)]
            (when (and p (<= (java.nio.file.Files/size p) max-read-size))
              (let [content (try
                             (json/parse-string (slurp (str p)) true)
                             (catch Throwable _ ::unparseable))]
                (boolean
                  (cond
                    (= content ::unparseable) false
                    (nil? content) false
                    (map? content)
                    (let [issues (or (:issues content) (:items content) (:list content))]
                      (and (sequential? issues) (seq issues)))
                    (sequential? content) (seq content)
                    :else (some? content))))))))
      (catch Throwable _ false))))

(defn failures-from-run [summary attempts artifacts run-dir]
  (vec (concat
         (when (#{"failed" "error"} (:status summary)) [{:source "run" :message (str "Run status: " (:status summary))}])
         (for [attempt attempts :when (#{"failed" "error"} (:status attempt))]
           {:source "attempt" :node_id (:node_id attempt) :message (or (:error attempt) "Attempt failed")})
         (for [artifact artifacts
               :when (and (:exists artifact) (re-find #"(?i)issues.*\.json$" (:path artifact)))
               :when (issues-artifact-has-issues? run-dir (:path artifact))]
           {:source "artifact" :path (:path artifact) :message "Issues artifact present"}))))

(defn get-run
  ([] (get-run {} nil nil))
  ([options run-id] (get-run options run-id nil))
  ([options run-id project-id]
   (let [sopts (project-scoped-opts options project-id)
         resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (let [{:keys [context state-file run-dir]} resolved
             summary (run-summary sopts state-file)
             run-id (:run_id summary)
             events (read-events-file (events-file run-dir))
             attempts (if (:error events) [] (attempts-from-context context events))
             artifacts (if (:error events) [] (list-artifacts* context run-dir events))
             ;; Heart-aware liveness: use the newest event :at as a fresh
             ;; activity signal in addition to state.edn's :updated_at, so a
             ;; node that is actively executing (emitting events) is not
             ;; wrongly marked stale/orphaned merely because :updated_at is
             ;; only bumped on node transitions. (DESIGN Change 2)
             last-activity (when-not (:error events) (latest-event-at events))
             live (derive-liveness summary attempts (when last-activity {:last-activity-at last-activity}))]
         (api-value
           {:run (-> summary
                     (assoc :liveness (:liveness live)
                            :staleness_seconds (:staleness_seconds live)
                            :attempts attempts
                            :failures (failures-from-run summary attempts artifacts run-dir)
                            :links {:events (str "/runs/" run-id "/events")
                                    :artifacts (str "/runs/" run-id "/artifacts")}))}))))))

(defn get-run-events
  ([] (get-run-events {} nil nil))
  ([options run-id] (get-run-events options run-id nil))
  ([options run-id project-id]
   (let [resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (let [events (read-events-file (events-file (:run-dir resolved)))]
         (if (:error events)
           events
           (api-value {:run_id run-id :events events :continuation nil})))))))

(defn delete-run
  "Delete a run directory. Refuses to delete a run whose recomputed liveness is
  `executing` (returns 409 conflict). Only deletes the run directory returned by
  `resolve-run`, which is confined to the configured `runs-root` tree, so there
  is no arbitrary-path delete surface."
  ([] (delete-run {} nil nil))
  ([options run-id] (delete-run options run-id nil))
  ([options run-id project-id]
   (let [sopts (project-scoped-opts options project-id)
         resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (let [{:keys [state-file run-dir context]} resolved
             summary (run-summary sopts state-file)
             events (read-events-file (events-file run-dir))
             attempts (if (:error events) [] (attempts-from-context context events))
             last-activity (when-not (:error events) (latest-event-at events))
             live (derive-liveness summary attempts (when last-activity {:last-activity-at last-activity}))]
         (if (= "executing" (:liveness live))
           (error-response 409 "conflict" "Run is still executing"
                           {:run_id run-id :liveness (:liveness live)})
           (do
             (fs/delete-tree run-dir)
             {:status 200
              :run_id run-id
              :deleted true
              :liveness (:liveness live)
              :path (relative-path (:workspace-root sopts) run-dir)})))))))

;; ---- approvals (manual-input :approval pause/resume) ----
;; Run-relative read surfaces for the manual-input node feature. The runtime
;; writes approvals/<state>-<attempt>.json (request) and
;; approvals/<state>-<attempt>-decision.json (decision) under the run dir; the
;; decision is recorded by `tesseraft runtime decide`. These functions expose
;; them read-only and also support run-relative artifact *comments*
;; (comments/<safe-path>.json arrays). Comments are workflow-behavior-free
;; metadata reconstructed from files (design §4).

(defn approvals-dir [run-dir] (fs/path run-dir "approvals"))

(defn comments-file [run-dir artifact-path]
  (let [rel (str artifact-path)
        err (reject-artifact-path rel)]
    (if err err
        (let [safe (fs/path "comments" (str (fs/path rel)))]
          ;; stable, traversal-safe single-file per artifact (e.g.
          ;; "comments/design/design.md.json").
          (fs/path run-dir (str safe) ".json")))))

(defn load-approval-summary [run-dir]
  (let [dir (approvals-dir run-dir)]
    (when (fs/exists? dir)
      ;; Collect pending approval-request records. A request file is named
      ;; <state>-<attempt>.json; its decision is <state>-<attempt>-decision.json.
      (let [files (for [f (file-seq (fs/file dir))
                        :when (and (.isFile f)
                                   (str/ends-with? (.getName f) ".json")
                                   (not (str/includes? (.getName f) "-decision.json")))]
                    f)]
        (->> files
             (keep (fn [f]
                     (try
                       (let [request (store/read-json (fs/path f))
                             approval-id (:approval_id request)
                             dec-path (fs/path dir (str approval-id "-decision.json"))
                             decision (when (fs/exists? dec-path) (store/read-json dec-path))]
                         (cond-> request
                           decision (assoc :decision decision)))
                       (catch Throwable _ nil))))
             (mapv #(api-value %)))))))

(defn load-approval [run-dir approval-id]
  ;; load-approval-summary returns api-value'd maps (string keys).
  (let [summaries (or (load-approval-summary run-dir) [])
        match (some #(when (= (str approval-id) (str (get % "approval_id"))) %)
                    summaries)]
    (if-not match
      (error-response 404 "not_found" "Approval not found" {:approval_id approval-id})
      ;; Enrich: look up the decision record if present.
      (let [dec-path (fs/path (approvals-dir run-dir) (str approval-id "-decision.json"))
            decision (when (fs/exists? dec-path) (store/read-json dec-path))]
        {:approval (cond-> match
                      decision (assoc "decision" (api-value decision)))}))))

(defn get-run-approvals
  ([] (get-run-approvals {} nil nil))
  ([options run-id] (get-run-approvals options run-id nil))
  ([options run-id project-id]
   (let [resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (api-value {:run_id run-id :approvals (or (load-approval-summary (:run-dir resolved)) [])})))))

(defn get-run-approval
  ([] (get-run-approval {} nil nil nil))
  ([options run-id approval-id] (get-run-approval options run-id approval-id nil))
  ([options run-id approval-id project-id]
   (let [resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (let [result (load-approval (:run-dir resolved) approval-id)]
         (if (:error result) result (api-value result)))))))

(defn get-run-comments
  ([] (get-run-comments {} nil nil nil))
  ([options run-id] (get-run-comments options run-id nil))
  ([options run-id project-id]
   (let [resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (let [artifact-path (or (some-> options :query :path) "")
             cf (comments-file (:run-dir resolved) artifact-path)
             comments (when (and (not (:error cf)) (fs/exists? cf)) (store/read-json cf))]
         (api-value {:run_id run-id :path artifact-path
                     :comments (mapv api-value (or comments []))}))))))

(defn timestamp [] (str (java.time.Instant/now)))
(defn random-id [] (str "c" (System/nanoTime)))

(defn add-run-comment
  ([] (add-run-comment {} nil nil nil nil))
  ([options run-id body] (add-run-comment options run-id body nil))
  ([options run-id body project-id]
   (let [{:keys [run-id-in-body]} (opts options)
         body (or body {})]
     (let [resolved (resolve-run options (or run-id run-id-in-body) project-id)]
       (if (:error resolved)
         resolved
         (let [artifact-path (or (get body :path) (get body "path"))
               anchor (or (get body :anchor) (get body "anchor"))
               text (or (get body :body) (get body "body"))]
           (cond
             (or (nil? artifact-path) (str/blank? (str artifact-path)))
             (error-response 400 "bad_request" "path is required")
             (or (nil? text) (str/blank? (str text)))
             (error-response 400 "bad_request" "body is required")
             :else
             (let [cf (comments-file (:run-dir resolved) artifact-path)]
               (if (:error cf) cf
                 (let [existing (if (fs/exists? cf) (store/read-json cf) [])
                       new-c {:id (random-id)
                              :path (str artifact-path)
                              :anchor (when (map? anchor) anchor)
                              :body (str text)
                              :author (or (get body :author) (get body "author"))
                              :created_at (timestamp)}
                       merged (conj (vec existing) new-c)]
                   (store/write-json! cf merged)
                   (api-value {:run_id run-id :comment (api-value new-c)})))))))))))

(comment
  ;; git-user config is also consumed by the runtime handlers in
  ;; tesseraft.adapters.builtin via -c user.name/user.email overrides.
  )

;; ---- git user config (source of truth: .tesseraft/git-user.json) ----
;; Defined here (after tesseraft-home) so sci analysis can resolve the
;; forward reference to tesseraft-home, which discovery-roots also uses.

(defn git-user-paths [options]
  (let [{:keys [workspace-root]} (opts options)
        home (tesseraft-home options)]
    {:project (fs/path workspace-root ".tesseraft" "git-user.json")
     :global (fs/path home "git-user.json")}))

(defn read-git-user-file [p]
  (when (fs/exists? p)
    (try (store/read-json p) (catch Throwable _ nil))))

(defn validate-git-user [name email]
  (cond
    (not (string? name)) "name must be a string"
    (str/blank? (str/trim name)) "name must not be empty"
    (> (count name) 200) "name must be at most 200 characters"
    (re-find #"\n" name) "name must not contain newlines"
    (not (string? email)) "email must be a string"
    (str/blank? (str/trim email)) "email must not be empty"
    (re-find #"[\s]" email) "email must not contain whitespace"
    (not (re-matches #"^[^@]+@[^@]+\.[^@]+$" email)) "email is not a valid address"
    :else nil))

(defn get-git-user
  ([] (get-git-user {} nil))
  ([options] (get-git-user options nil))
  ([options project-id]
   (let [sopts (project-scoped-opts options project-id)
         {:keys [project global]} (git-user-paths sopts)
         project-user (read-git-user-file project)
         global-user (read-git-user-file global)]
     (cond
       project-user {:git_user (assoc project-user :source "project")}
       global-user {:git_user (assoc global-user :source "global")}
       :else {:git_user {:name nil :email nil :source "none"}}))))

(defn set-git-user
  ([options name email global?] (set-git-user options name email global? nil))
  ([options name email global? project-id]
   (if-let [err (validate-git-user name email)]
     (error-response 400 "bad_request" err)
     (let [sopts (project-scoped-opts options project-id)
           paths (git-user-paths sopts)
           target (if global? (:global paths) (:project paths))]
       (fs/create-dirs (fs/parent target))
       (store/write-json! target {:name name :email email})
       (get-git-user sopts project-id)))))

;; ---- settings read/mutate surface ----
;; `settings-fields`, `settings-unchanged`, `settings-paths`,
;; `read-settings-file`, `coerce-settings`, and `mask-token` are hoisted above
;; (near the project aggregate) so `synthesize-default-project` can resolve them
;; at sci analysis time. The remaining settings surface — token-field set,
;; length limits, per-field validation, full mask, and get/set endpoints — lives
;; here.

(def ^:private settings-token-fields
  #{:github_token :jira_token})

(def ^:private settings-length-limits
  {:pi_default_provider 100 :pi_default_model 200
   :github_token 500 :jira_token 500 :default_repo_root 1000})

(defn validate-settings-field [k v]
  (cond
    (nil? v) nil ;; not provided; nothing to validate
    (and (= k :color_scheme) (not (#{"classic" "matrix"} v)))
    "color_scheme must be one of: classic, matrix"
    (not (string? v)) (str (name k) " must be a string")
    (str/blank? (str/trim v)) (str (name k) " must not be empty")
    (re-find #"\n" v) (str (name k) " must not contain newlines")
    :else
    (let [limit (get settings-length-limits k)]
      (if (and limit (> (count v) limit))
        (str (name k) " must be at most " limit " characters")
        nil))))

(defn mask-settings [settings]
  (let [base {:pi_default_provider (or (:pi_default_provider settings) nil)
              :pi_default_model (or (:pi_default_model settings) nil)
              :default_repo_root (or (:default_repo_root settings) nil)
              :color_scheme (or (:color_scheme settings) "classic")}]
    (-> base
        (api-value)
        (assoc :github_token (mask-token (:github_token settings))
               :jira_token (mask-token (:jira_token settings))))))

(defn get-settings
  ([] (get-settings {} nil))
  ([options] (get-settings options nil))
  ([options project-id]
   (let [sopts (project-scoped-opts options project-id)
         {:keys [project global]} (settings-paths sopts)
         project-settings (coerce-settings (read-settings-file project))
         global-settings (coerce-settings (read-settings-file global))
         [source raw] (cond
                        (seq project-settings) ["project" project-settings]
                        (seq global-settings) ["global" global-settings]
                        :else ["none" {}])
         masked (-> raw (mask-settings) (assoc :source source))]
     {:settings masked})))

(defn set-settings
  "Apply a partial update to the project (or global) settings file. `updates`
  maps known field keywords to their new values. Entries may be nil (clear the
  field) or, for token fields, the `settings-unchanged` sentinel to preserve.
  Unknown keys are rejected. Returns the masked `get-settings` view."
  ([options updates] (set-settings options updates false nil))
  ([options updates global?] (set-settings options updates global? nil))
  ([options updates global? project-id]
   (let [sopts (project-scoped-opts options project-id)]
     (if (empty? updates)
       (get-settings sopts project-id)
       (let [unknown (remove (set settings-fields) (keys updates))]
         (if (seq unknown)
           (error-response 400 "bad_request"
                           (str "Unknown settings fields: "
                                (str/join ", " (map name (sort unknown)))))
           (let [errs (reduce (fn [acc [k v]]
                                (if-let [e (validate-settings-field k v)]
                                  (conj acc e) acc))
                              [] updates)]
             (if (seq errs)
               (error-response 400 "bad_request" (str/join "; " errs))
               (let [paths (settings-paths sopts)
                     target (if global? (:global paths) (:project paths))
                   current (coerce-settings (read-settings-file target))
                   merged (reduce
                              (fn [acc [k v]]
                                (cond
                                  ;; Token unchanged: keep whatever is (or isn't) there.
                                  (and (settings-token-fields k)
                                       (= v settings-unchanged))
                                  acc
                                  ;; Clear: drop the key entirely (nil update).
                                  (nil? v) (dissoc acc k)
                                  ;; Set/replace.
                                  :else (assoc acc k v)))
                              current updates)]
               ;; Cross-field consistency: a default model without a default
               ;; provider is an inconsistent state. Reject it here so the
               ;; store never holds model-without-provider (this also defends
               ;; the CLI and direct API callers, not just the web UI).
               (if (and (contains? merged :pi_default_model)
                        (not (contains? merged :pi_default_provider)))
                 (error-response 400 "bad_request"
                                 "pi_default_provider is required when pi_default_model is set")
                 (do
                   (fs/create-dirs (fs/parent target))
                   (store/write-json! target merged)
                   (get-settings sopts project-id))))))))))))
