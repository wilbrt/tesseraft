(ns tesseraft.control-plane.projects
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.string :as str]
            [tesseraft.capabilities.executors :as executor-catalog]
            [tesseraft.capabilities.handlers :as handler-catalog]
            [tesseraft.control-plane.common :refer [abs-path api-value error-response opts path-prefix? relative-path tesseraft-home]]
            [tesseraft.credentials.store :as credential-store]
            [tesseraft.persistence.safe-write :as safe-write]
            [tesseraft.project.connections :as project-connections]
            [tesseraft.project.descriptor :as project-descriptor]
            [tesseraft.project.registry :as project-registry]
            [tesseraft.runtime.store :as store]
            [tesseraft.spec :as spec]
            [tesseraft.work-tracker.catalog :as work-tracker-catalog]))

(def ^:private project-id-re project-descriptor/project-id-re)

(defn- contains-raw-secret-key? [x]
  (project-connections/contains-raw-secret-key? x))

(defn valid-project-id? [s]
  (project-descriptor/valid-project-id? s))

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
  `env:`, `tesseraft:`, and `github-actions:` stores are recognized shape-wise;
  local resolution is wired only for the selected store."
  [s]
  (project-connections/credential-ref? s))

(defn- normalize-key [k]
  (keyword (str/replace (if (keyword? k) (name k) (str k)) #"_" "-")))

(defn- normalize-keys-shallow [m]
  (into {} (map (fn [[k v]] [(normalize-key k) v]) m)))

(defn- unsupported-fields [m allowed]
  (seq (remove allowed (keys m))))

(defn- validate-work-tracker-config
  "Returns nil when `config` satisfies `provider`'s registered schema, else a
  structured `{:kind :missing-fields|:unsupported-provider|:unsupported-fields|:invalid-value
  :message \"<string>\"}`. `:message` text is a stable public contract (WT3
  assertions depend on it byte-for-byte)."
  [provider config]
  (let [schema (work-tracker-catalog/descriptor provider)]
    (cond
      (nil? schema) {:kind :unsupported-provider :message (str "Unsupported work-tracker provider: " (name provider))}
      (not (map? config)) {:kind :invalid-value :message "work-tracker config must be an object"}
      :else
      (let [config* (normalize-keys-shallow config)
            fields (:form-fields schema)
            required (set (map :name (filter :required fields)))
            allowed (set (map :name fields))]
        (cond
          (seq (unsupported-fields config* allowed))
          {:kind :unsupported-fields :message (str "Unsupported work-tracker config fields: " (str/join ", " (map name (unsupported-fields config* allowed))))}
          (seq (remove #(contains? config* %) required))
          {:kind :missing-fields :message (str "Missing work-tracker config fields: " (str/join ", " (map name (remove #(contains? config* %) required))))}
          :else
          (when-let [err (work-tracker-catalog/validate-config provider config*)]
            {:kind :invalid-value :message err}))))))

(defn normalize-work-tracker
  "Normalize and validate a work-tracker envelope. Returns normalized map or
  an error-response. nil means no tracker."
  [raw]
  (when-let [result (project-connections/normalize-work-tracker raw)]
    (if-let [message (:error result)]
      (error-response 400 "bad_request" message)
      result)))

(defn list-work-tracker-providers
  "Read-only, process-global provider field metadata for the schema-driven
  Settings editor. Never includes credential values; `credential-ref` is
  always required at the envelope level regardless of provider."
  ([] (list-work-tracker-providers {}))
  ([_options]
   {:providers (mapv api-value (work-tracker-catalog/public-descriptors))}))

(defn list-capabilities
  "Public, secret-free metadata derived from the three executable catalogs."
  ([] (list-capabilities {}))
  ([_options]
   {:node_types (mapv (fn [id] {:id (name id) :label (str/capitalize (name id))})
                      (sort-by name spec/valid-node-types))
    :handlers (mapv api-value (handler-catalog/public-descriptors))
    :executors (mapv api-value (executor-catalog/public-descriptors))
    :work_trackers (:providers (list-work-tracker-providers))}))

(defn- normalize-connection-entry [k v]
  (project-connections/normalize-connection-entry k v))

(defn- validate-connections [conn prefix]
  (project-connections/validate-connections conn prefix))

(defn- normalize-connections [connections]
  (project-connections/normalize-connections connections))

(defn project-registry-path [options]
  (project-registry/path (tesseraft-home options)))

(defn- validate-project-registry [registry]
  (project-registry/validate registry))

(defn invalid-project-registry-response [e]
  (error-response 400 "invalid_project_registry" (.getMessage e)
                  {:registry_path (:path (ex-data e))}))

(defn read-project-registry [options]
  (project-registry/read! (tesseraft-home options)))

(defn read-project-registration [options project-id]
  (project-registry/registration (read-project-registry options) project-id))

(declare read-project-descriptor read-project-descriptor-at-root project-scoped-opts project-descriptor-path resolve-project)

(defn- portable-descriptor-write-shape [project-id project]
  (project-descriptor/write-shape project-id project))

(defn- raw-connections-at-path
  "Returns `{:connections <raw map or nil> :unreadable? <bool>}`. A missing
  file is `{:connections nil :unreadable? false}` (a valid \"nothing here\"
  state); a file that exists but is not readable/parseable JSON is
  `{:connections nil :unreadable? true}` so callers can distinguish an
  intentionally absent tracker from a corrupt durable source."
  [p]
  (if-not (fs/exists? p)
    {:connections nil :unreadable? false}
    (try
      (let [raw (store/read-json p)]
        {:connections (when (map? raw) (:connections raw)) :unreadable? false})
      (catch Throwable _
        {:connections nil :unreadable? true}))))

(defn project-connection-source
  "Read-only: the raw durable source backing `project-id`'s connections, using
  the registered or discovered descriptor. Returns
  `{:kind :descriptor :path <string path> :connections <raw map or
    nil> :unreadable? <bool>}`. `:path` is coerced to a string so the return
  value is JSON-serializable as-is. Connections are read directly from JSON
  without descriptor/schema validation, so a malformed tracker inside an
  otherwise-invalid descriptor can still be diagnosed instead of only
  surfacing as whole-project resolution failure. An optional third
  `registration` arg lets callers that already read the project registry
  avoid re-reading it."
  ([options project-id] (project-connection-source options project-id (read-project-registration options project-id)))
  ([options project-id registration]
   (let [descriptor-root (or (:workspace_root registration)
                             (some-> (read-project-descriptor options) :workspace_root))]
     (if descriptor-root
       (let [descriptor-path (project-descriptor-path descriptor-root)
           raw (raw-connections-at-path descriptor-path)]
         {:kind :descriptor
          :path (str descriptor-path)
          :connections (:connections raw)
          :unreadable? (:unreadable? raw)})
       {:kind :none :path nil :connections nil :unreadable? false}))))

(defn- durable-project-write-target [options project-id]
  (let [resolved (resolve-project options project-id)]
    (cond
      (:error resolved) resolved
      (= :implicit (:source resolved))
      (error-response 409 "project_not_initialized"
                      "The implicit project is read-only; run `tesseraft init` to create .tesseraft/project.json"
                      {:project_id (or project-id "default")})
      :else
      {:kind :descriptor
       :path (str (project-descriptor-path (:workspace_root resolved)))
       :current resolved})))

(defn- project-descriptor-path [project-root]
  (project-descriptor/path project-root))

(defn- validate-project-descriptor [raw]
  (project-descriptor/validate raw))

(defn- normalize-project-descriptor [project-root raw]
  (project-descriptor/normalize project-root raw))

(defn- nearest-project-descriptor-root [start]
  (loop [dir (fs/normalize (fs/path start))]
    (let [descriptor (project-descriptor-path dir)
          parent (fs/parent dir)]
      (cond
        (fs/exists? descriptor) dir
        (or (nil? parent) (= dir parent)) nil
        :else (recur parent)))))

(defn- read-project-descriptor-at-root [root unreadable-message]
  (let [p (project-descriptor-path root)]
    (if-not (fs/exists? p)
      (error-response 400 "invalid_project_descriptor"
                      "Explicit project root is missing .tesseraft/project.json descriptor"
                      {:project_root (str root)
                       :descriptor_path (str p)})
      (try
        (let [raw (store/read-json p)]
          (if-let [err (validate-project-descriptor raw)]
            (error-response 400 "invalid_project_descriptor" err
                            {:project_root (str root)
                             :descriptor_path (str p)})
            (normalize-project-descriptor root raw)))
        (catch Throwable t
          (error-response 400 "invalid_project_descriptor"
                          unreadable-message
                          {:project_root (str root)
                           :descriptor_path (str p)
                           :message (.getMessage t)}))))))

(defn read-project-descriptor [options]
  (let [options* (opts options)
        explicit-root (:project-root options*)
        root (if explicit-root
               (abs-path (:workspace-root options*) explicit-root)
               (nearest-project-descriptor-root (abs-path (:workspace-root options*) ".")))]
    (when root
      (read-project-descriptor-at-root root
                                       (if explicit-root
                                         "Explicit project root has an unreadable .tesseraft/project.json descriptor"
                                         "Discovered project root has an unreadable .tesseraft/project.json descriptor")))))

(defn list-project-manifests [options]
  (->> (:projects (read-project-registry options))
       (map (fn [[id entry]]
              (let [descriptor (read-project-descriptor-at-root
                                 (:workspace_root entry)
                                 "Registered project root has an unreadable .tesseraft/project.json descriptor")]
                (if (:error descriptor)
                  {:project_id (name id)
                   :workspace_root (:workspace_root entry)
                   :source "registration"
                   :error (:error descriptor)}
                  {:project_id (name id)
                   :name (or (:name descriptor) (name id))
                   :workspace_root (:workspace_root entry)
                   :source "registration"}))))
       vec))

(defn read-credentials [options]
  (try (credential-store/read-store options) (catch Throwable _ nil)))

(defn valid-local-credential-store? [creds]
  (credential-store/valid? creds))

(defn local-credential-value [options _ref path]
  (credential-store/local-value options path))

(defn production-credential-resolver
  "Resolve a validated credential ref from its production-selected store."
  [options ref]
  (credential-store/production-resolver options ref))

(defn- resolver-failure [ref]
  {:present false
   :state "invalid"
   :credential-ref ref
   :error "credential resolver failed"})

(defn- valid-resolver-result? [result]
  (and (map? result)
       (boolean? (:present result))
       (contains? #{"present" "absent" "unresolved" "invalid"} (:state result))
       (if (= "present" (:state result))
         (and (:present result) (string? (:value result)) (not (str/blank? (:value result))))
         (not (:present result)))))

(defn- normalized-resolver-result [ref result injected?]
  (let [base (cond-> {:present (:present result)
                      :state (:state result)
                      :credential-ref ref}
               (= "present" (:state result)) (assoc :value (:value result)))]
    (case (:state result)
      "invalid" (assoc base :error (if injected?
                                      "credential resolver reported invalid"
                                      (or (:error result) "invalid credential")))
      "unresolved" (assoc base :unresolved (if injected?
                                             "credential resolver unavailable"
                                             (or (:unresolved result) "credential resolver unavailable")))
      base)))

(defn resolve-credential
  "Resolve a credential ref through the project-scoped resolver in `options`,
  defaulting to the production environment/local-store resolver. Injected
  resolvers receive `[scoped-options ref]` and are intentionally ephemeral.
  Returns stable non-secret state plus `:value` only for in-process consumers;
  public callers must drop `:value` before serialization."
  [options ref]
  (credential-store/resolve (opts options) ref))

(defn- norm-discovery [raw]
  (cond
    (nil? raw) nil
    (map? raw)
    (into {} (for [k [:workflow-roots :tesseraft-home]
                   :when (contains? raw k)]
               [k (get raw k)]))
    :else nil))

(defn- norm-connections [raw]
  (normalize-connections raw))

(defn synthesize-default-project
  "Build the zero-configuration implicit project. It contains no integrations,
  credential references, legacy settings, or machine-local descriptor fields."
  [options]
  (let [{:keys [workspace-root runs-root workflow-roots]} (opts options)]
    {:project_id "default"
     :name "Default"
     :workspace_root (str (abs-path workspace-root "."))
     :runs_root runs-root
     :discovery {:workflow-roots (vec workflow-roots)}
     :connections {}
     :source :implicit}))

(defn- canonical-project-root [options root]
  (let [root* (abs-path (:workspace-root (opts options)) root)]
    (try
      (.getCanonicalPath (fs/file root*))
      (catch Throwable _
        (str root*)))))

(defn- project-root-exists? [options root]
  (fs/exists? (abs-path (:workspace-root (opts options)) root)))

(defn- stale-project-root-response [options project-id root]
  (error-response 409 "stale_project_root" "Registered project root is missing"
                  {:project_id project-id
                   :recorded_root (canonical-project-root options root)
                   :searched_for_replacement false}))

(defn resolve-project
  "Resolve the nearest v2 descriptor or an explicitly registered project.
  Legacy manifests and descriptor v1 are migration inputs, never fallbacks."
  ([options] (resolve-project options nil))
  ([options project-id]
   (let [pid (or project-id "default")
         local (read-project-descriptor options)]
     (cond
       (and local (:error local)) local
       (and local (or (nil? project-id) (= "default" pid) (= pid (:project_id local))))
       (assoc local :source :descriptor)
       (not (valid-project-id? pid))
       (error-response 400 "bad_request" "Invalid project_id"
                       {:project_id pid :pattern "^[a-z0-9][a-z0-9-]{0,62}$"})
       :else
       (if-let [registration (read-project-registration options pid)]
         (let [root (:workspace_root registration)]
           (if-not (project-root-exists? options root)
             (stale-project-root-response options pid root)
             (let [registered (read-project-descriptor-at-root
                                root "Registered project root has an unreadable .tesseraft/project.json descriptor")]
               (cond
                 (:error registered) registered
                 (not= pid (:project_id registered))
                 (error-response 409 "project_identity_conflict"
                                 "Registry project id does not match the descriptor at its canonical root"
                                 {:project_id pid :descriptor_project_id (:project_id registered)
                                  :workspace_root root})
                 :else (assoc registered :source :registration)))))
         (if (= "default" pid)
           (synthesize-default-project options)
           (error-response 404 "not_found" "Project not found" {:project_id pid})))))))

(defn list-projects
  ([] (list-projects {}))
  ([options]
   (let [manifests (list-project-manifests options)
         has-default? (some #(= "default" (:project_id %)) manifests)]
     (if has-default?
       {:projects (mapv api-value manifests)}
       ;; Synthesize the implicit default whenever no explicit default source
       ;; exists, even when other registrations are present.
       ;; This preserves existing unscoped/default behavior while allowing
       ;; user-local registries to list additional projects.
       {:projects (mapv api-value
                        (vec (cons (-> (synthesize-default-project options)
                                       (select-keys [:project_id :name :source]))
                                   manifests)))}))))

(defn get-project
  ([] (get-project {} nil))
  ([options project-id]
   (let [resolved (resolve-project options project-id)]
     (if (:error resolved)
       resolved
;; Secrets never leave `get-project`: tokens are already masked in
;; `synthesize-default-project`; persisted descriptors store only credential
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
  (let [wr (str (fs/absolutize (or (:workspace-root (opts options)) ".")))
        confinement-root (if (and (= "registration" (:source spec))
                                  (string? (:workspace_root spec)))
                           (:workspace_root spec)
                           wr)]
    (cond
      (not (valid-project-id? project-id))
      (str "Invalid project_id (expected " project-id-re ")")

      (and (contains? spec :workspace_root) (not (string? (:workspace_root spec))))
      "workspace_root must be a string"

      (and (contains? spec :runs_root) (not (string? (:runs_root spec))))
      "runs_root must be a string"

      (and (contains? spec :workspace_root)
           (not= "registration" (:source spec))
           (not (path-prefix? (abs-path wr ".")
                             (abs-path wr (:workspace_root spec)))))
      "workspace_root must be under the current workspace"

      ;; runs_root is resolved relative to the workspace root and must stay
      ;; confined under it: reject any `..` component or absolute path outside
      ;; the workspace. This is the control-plane-level confinement that
      ;; prevents run artifacts from being written to arbitrary filesystem
      ;; locations (design §6 path-confinement risk).
      (and (contains? spec :runs_root)
           (or (path-escape-component? confinement-root (:runs_root spec))
               (not (path-prefix? (abs-path confinement-root ".")
                                 (abs-path confinement-root (:runs_root spec))))))
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

          :else
          (validate-connections conn "project"))))))

(defn create-project
  ([options project-id spec] (create-project options project-id spec false))
  ([options project-id spec _global?]
   (let [spec (or spec {})
         configured-root (or (:workspace_root spec) (:workspace-root (opts options)) ".")
         root (str (fs/normalize
                    (if (fs/absolute? (fs/path configured-root))
                      (fs/absolutize configured-root)
                      (abs-path (:workspace-root (opts options)) configured-root))))
         descriptor-path (project-descriptor-path root)
         registration? (= "registration" (:source spec))]
     (cond
       (not (valid-project-id? project-id))
       (error-response 400 "bad_request" "Invalid project_id"
                       {:project_id project-id :pattern "^[a-z0-9][a-z0-9-]{0,62}$"})
       (contains-raw-secret-key? spec)
       (error-response 400 "bad_request"
                      "Raw secret payloads are not accepted; provide a credential-ref instead")
       :else
       (if-let [err (validate-project-spec options project-id spec)]
         (error-response 400 "bad_request" err)
         (try
           (let [registry (read-project-registry options)
                 existing-registration (get-in registry [:projects (keyword project-id)])
                 existing-descriptor (when (fs/exists? descriptor-path)
                                       (read-project-descriptor-at-root root "Project descriptor is unreadable"))]
             (cond
               (and existing-registration
                    (not= (canonical-project-root options root)
                          (canonical-project-root options (:workspace_root existing-registration))))
               (error-response 409 "project_identity_conflict"
                               "Project id is already registered at a different root"
                               {:project_id project-id :workspace_root (:workspace_root existing-registration)})

               (and existing-descriptor (:error existing-descriptor)) existing-descriptor
               (and existing-descriptor (not= project-id (:project_id existing-descriptor)))
               (error-response 409 "project_identity_conflict"
                               "Project root already contains a descriptor with a different id"
                               {:project_id project-id :descriptor_project_id (:project_id existing-descriptor)})
               (and registration? (nil? existing-descriptor))
               (error-response 400 "invalid_project_descriptor"
                               "project register requires a v2 .tesseraft/project.json descriptor"
                               {:project_root root :descriptor_path (str descriptor-path)})
               :else
               (let [descriptor-data (or existing-descriptor
                                         (portable-descriptor-write-shape
                                           project-id
                                           {:name (or (:name spec) project-id)
                                            :runs_root (or (:runs_root spec) "runs")
                                            :discovery (or (:discovery spec)
                                                           {:workflow-roots (:workflow-roots (opts options))})
                                            :runtime_defaults (:runtime_defaults spec)
                                            :connections (normalize-connections (:connections spec))}))
                     descriptor-created? (nil? existing-descriptor)]
                 (try
                   (when descriptor-created?
                     (safe-write/write-json! descriptor-path descriptor-data))
                   (project-registry/write! (tesseraft-home options)
                                            (project-registry/put registry project-id root))
                   (get-project options project-id)
                   (catch Throwable t
                     (when descriptor-created? (fs/delete-if-exists descriptor-path))
                     (throw t))))))
           (catch clojure.lang.ExceptionInfo e
             (if (= :invalid-project-registry (:code (ex-data e)))
               (invalid-project-registry-response e)
               (throw e)))))))))

(defn unregister-project
  ([options project-id]
   (if-not (valid-project-id? project-id)
     (error-response 400 "bad_request" "Invalid project_id"
                     {:project_id project-id :pattern "^[a-z0-9][a-z0-9-]{0,62}$"})
     (try
       (let [registry (read-project-registry options)
             existed? (contains? (:projects registry) (keyword project-id))]
         (project-registry/write! (tesseraft-home options)
                                  (project-registry/remove-project registry project-id))
         {:project_id project-id :deleted existed?})
       (catch clojure.lang.ExceptionInfo e
         (if (= :invalid-project-registry (:code (ex-data e)))
           (error-response 400 "invalid_project_registry" (.getMessage e) {:registry_path (:path (ex-data e))})
           (throw e)))))))

(defn update-project
  ([options project-id spec] (update-project options project-id spec false))
  ([options project-id spec _global?]
   ;; Every project mutation validates durable registry state before inspecting
   ;; or changing project-owned state.
   (read-project-registry options)
   (let [spec (or spec {})]
     (cond
       (not (valid-project-id? project-id))
       (error-response 400 "bad_request" "Invalid project_id"
                       {:project_id project-id :pattern "^[a-z0-9][a-z0-9-]{0,62}$"})

       (contains-raw-secret-key? spec)
       (error-response 400 "bad_request"
                      "Raw secret payloads are not accepted; provide a credential-ref instead")

       :else
       (if-let [err (validate-project-spec options project-id spec)]
         (error-response 400 "bad_request" err)
         (let [target (durable-project-write-target options project-id)]
           (if (:error target)
             target
             (let [current (:current target)
                   spec* (cond-> spec (contains? spec :connections) (update :connections normalize-connections))
                   merged (merge current spec*)
                   merged (if (contains? spec* :connections)
                            (assoc merged :connections (merge (:connections current {}) (:connections spec*)))
                            merged)
                   writable (portable-descriptor-write-shape project-id merged)]
               (safe-write/write-json! (:path target) writable)
               (get-project options project-id)))))))))

(defn mask-credential
  "Resolve a credential-ref and return only stable non-secret state."
  [options ref]
  (dissoc (resolve-credential options ref) :value))

(defn get-project-connections
  ([] (get-project-connections {} nil))
  ([options project-id]
   (let [resolved (resolve-project options project-id)
         sopts (when-not (:error resolved) (project-scoped-opts options project-id))]
     (cond
       (:error resolved) resolved
       (:error sopts) sopts
       :else
       {:connections
        (into {} (for [[k v] (:connections resolved {})]
                   (let [ref (:credential-ref v)
                         masked (mask-credential sopts ref)]
                     [k (api-value (merge v {:credential-state masked}))])))}))))

(defn- work-tracker-diagnosis-result
  [state source-label & {:keys [provider credential-ref credential-state message remediation]}]
  {:state state
   :provider provider
   :credential-ref credential-ref
   :credential-state credential-state
   :source source-label
   :message message
   :remediation remediation})

(defn- work-tracker-raw-source
  "Shared extraction of the raw durable source for `project-id`'s
  work-tracker diagnosis. Accepts an optional pre-fetched `source` (a
  `project-connection-source` result) so a single caller-level read of the
  registry and durable file backs `work-tracker-diagnosis` and its
  config-only/credential-only siblings within one report; each classifies
  identical raw bytes only when the caller shares one `source` across all
  three calls (as `doctor-report` does)."
  ([options project-id] (work-tracker-raw-source options project-id (project-connection-source options project-id)))
  ([options project-id source]
   (let [raw-conn (when (map? (:connections source)) (normalize-keys-shallow (:connections source)))]
     {:source-label (name (:kind source))
      :path (:path source)
      :unreadable? (boolean (:unreadable? source))
      :raw-tracker (:work-tracker raw-conn)})))

(defn- work-tracker-envelope-issue
  "Envelope-level problems shared by both the config and credential concern:
  a malformed envelope, a raw secret, unknown fields, or an unsupported
  schema-version. Returns nil or `{:message :remediation}`."
  [raw-tracker]
  (cond
    (not (map? raw-tracker))
    {:message "work-tracker must be an object"
     :remediation "Fix the work-tracker envelope in the project descriptor or manifest."}

    (contains-raw-secret-key? raw-tracker)
    {:message "Raw secret payloads are not accepted; provide a credential-ref instead"
     :remediation "Replace the raw secret with a credential-ref such as env:NAME."}

    :else
    (let [m (normalize-keys-shallow raw-tracker)]
      (cond
        (seq (unsupported-fields m #{:provider :schema-version :credential-ref :config}))
        {:message "work-tracker contains unknown fields"
         :remediation "Remove unsupported fields from the work-tracker envelope."}

        (and (contains? m :schema-version) (not= 1 (:schema-version m)))
        {:message "Unsupported work-tracker schema-version"
         :remediation "Use schema-version 1, or omit schema-version."}

        :else nil))))

(defn- work-tracker-envelope-fields
  "Normalized provider/credential-ref/config fields shared by all three
  work-tracker diagnosis functions, extracted once so each function's
  field-derivation logic lives in a single place."
  [raw-tracker]
  (let [m (normalize-keys-shallow raw-tracker)
        provider-raw (:provider m)
        provider (when (or (string? provider-raw) (keyword? provider-raw)) (normalize-key provider-raw))
        ref (:credential-ref m)]
    {:provider provider
     :provider-name (some-> provider name)
     :credential-ref ref
     :credential-ref-str (when (string? ref) ref)
     :config (:config m)}))

(defn- work-tracker-provider-issue
  "nil, or `{:state :message :remediation}` for the provider portion of a
  normalized work-tracker envelope: missing or unregistered provider."
  [provider provider-name]
  (cond
    (nil? provider)
    {:state "incomplete"
     :message "work-tracker provider is required and must be a string"
     :remediation "Set a provider such as plane, jira, or github-issues."}

    (nil? (work-tracker-catalog/descriptor provider))
    {:state "invalid"
     :message (str "Unsupported work-tracker provider: " provider-name)
     :remediation "Choose a supported built-in provider."}

    :else nil))

(defn- work-tracker-ref-issue
  "nil, or `{:state :message :remediation}` for the credential-ref portion of
  a normalized work-tracker envelope: missing or malformed ref syntax."
  [ref]
  (cond
    (nil? ref)
    {:state "incomplete"
     :message "work-tracker credential-ref is required"
     :remediation "Set a credential-ref such as env:NAME."}

    (not (credential-ref? ref))
    {:state "invalid"
     :message "Invalid work-tracker credential-ref"
     :remediation "Use env:NAME, tesseraft:NAME, or github-actions:NAME."}

    :else nil))

(defn- work-tracker-config-value-issue
  "nil, or `{:state :message :remediation}` for the config-value portion of a
  normalized work-tracker envelope: a non-object config, or a config that
  fails `validate-work-tracker-config` (missing fields vs. an invalid value)."
  [provider config]
  (cond
    (not (map? config))
    {:state "invalid"
     :message "work-tracker config must be an object"
     :remediation "Provide config as a JSON object."}

    :else
    (when-let [config-err (validate-work-tracker-config provider (normalize-keys-shallow config))]
      (let [incomplete? (= :missing-fields (:kind config-err))]
        {:state (if incomplete? "incomplete" "invalid")
         :message (:message config-err)
         :remediation (if incomplete?
                        "Set the missing provider configuration fields."
                        "Fix the invalid provider configuration.")}))))

(defn- work-tracker-credential-readiness
  "`{:state \"ready\"|\"unresolved\" :credential-state :message :remediation}`
  for a syntactically valid credential-ref, resolved via `mask-credential`
  (state only; never a credential value)."
  [options project-id ref]
  (let [sopts* (project-scoped-opts options project-id)
        sopts (if (:error sopts*) options sopts*)
        credential-state (:state (mask-credential sopts ref))]
    (if (= "present" credential-state)
      {:state "ready" :credential-state credential-state
       :message "Work tracker configuration is statically ready."
       :remediation nil}
      {:state "unresolved" :credential-state credential-state
       :message "The reference is owned by this project; the value is owned by your user, machine, or CI."
       :remediation "Set the referenced credential locally, or in CI."})))

(defn- work-tracker-prologue-result
  "The three outcomes shared verbatim by all three work-tracker diagnosis
  functions: an unreadable durable source, an absent tracker, or an
  envelope-level issue. Returns nil when none apply, meaning the caller
  should proceed to its own concern-specific classification."
  [source-label unreadable? raw-tracker path]
  (cond
    unreadable?
    (work-tracker-diagnosis-result "invalid" source-label
      :message "Project connection source is not readable JSON"
      :remediation (str "Fix or remove the malformed file at " path "."))

    (nil? raw-tracker)
    (work-tracker-diagnosis-result "absent" source-label
      :message "No primary work tracker is configured for this project; this is a valid project state."
      :remediation nil)

    :else
    (when-let [issue (work-tracker-envelope-issue raw-tracker)]
      (work-tracker-diagnosis-result "invalid" source-label
        :message (:message issue) :remediation (:remediation issue)))))

(defn work-tracker-diagnosis
  "Non-secret diagnosis of the *raw durable source* backing `project-id`'s
  `connections.work-tracker`, independent of whether the project as a whole
  resolves cleanly. Never returns a config value or credential value/preview.
  States: absent, incomplete, invalid, unresolved, ready (see
  docs/archive/PROJECT_WORK_TRACKER_DESIGN.md WT4 D1). An optional third `source` arg
  (a `project-connection-source` result) lets callers share one raw-source
  read across this and its config-only/credential-only siblings."
  ([options project-id] (work-tracker-diagnosis options project-id (project-connection-source options project-id)))
  ([options project-id source]
   (let [{:keys [source-label unreadable? raw-tracker path]} (work-tracker-raw-source options project-id source)]
     (or
       (work-tracker-prologue-result source-label unreadable? raw-tracker path)
       (let [{:keys [provider provider-name credential-ref credential-ref-str config]} (work-tracker-envelope-fields raw-tracker)]
         (or
           (when-let [issue (work-tracker-provider-issue provider provider-name)]
             (work-tracker-diagnosis-result (:state issue) source-label
               :provider provider-name :credential-ref credential-ref-str
               :message (:message issue) :remediation (:remediation issue)))
           (when-let [issue (work-tracker-ref-issue credential-ref)]
             (work-tracker-diagnosis-result (:state issue) source-label
               :provider provider-name :credential-ref credential-ref-str
               :message (:message issue) :remediation (:remediation issue)))
           (when-let [issue (work-tracker-config-value-issue provider config)]
             (work-tracker-diagnosis-result (:state issue) source-label
               :provider provider-name :credential-ref credential-ref-str
               :message (:message issue) :remediation (:remediation issue)))
           (let [readiness (work-tracker-credential-readiness options project-id credential-ref)]
             (work-tracker-diagnosis-result (:state readiness) source-label
               :provider provider-name :credential-ref credential-ref-str :credential-state (:credential-state readiness)
               :message (:message readiness) :remediation (:remediation readiness)))))))))

(defn work-tracker-config-diagnosis
  "Non-secret diagnosis of only the provider/config portion of the raw
  work-tracker envelope backing `project-id`, independent of whether the
  credential-ref is present, well-formed, or resolves. Backs the doctor's
  `work-tracker-config` check; see `work-tracker-diagnosis` for the combined,
  credential-aware verdict used for the report-level `work_tracker` block.
  Accepts the same optional `source` arg as `work-tracker-diagnosis`."
  ([options project-id] (work-tracker-config-diagnosis options project-id (project-connection-source options project-id)))
  ([options project-id source]
   (let [{:keys [source-label unreadable? raw-tracker path]} (work-tracker-raw-source options project-id source)]
     (or
       (work-tracker-prologue-result source-label unreadable? raw-tracker path)
       (let [{:keys [provider provider-name config]} (work-tracker-envelope-fields raw-tracker)]
         (or
           (when-let [issue (work-tracker-provider-issue provider provider-name)]
             (work-tracker-diagnosis-result (:state issue) source-label
               :provider provider-name :message (:message issue) :remediation (:remediation issue)))
           (when-let [issue (work-tracker-config-value-issue provider config)]
             (work-tracker-diagnosis-result (:state issue) source-label
               :provider provider-name :message (:message issue) :remediation (:remediation issue)))
           (work-tracker-diagnosis-result "ready" source-label
             :provider provider-name
             :message "Work tracker provider and configuration are statically valid."
             :remediation nil)))))))

(defn work-tracker-credential-diagnosis
  "Non-secret diagnosis of only the credential-reference portion of the raw
  work-tracker envelope backing `project-id`, independent of whether the
  provider/config is registered or valid. Backs the doctor's
  `work-tracker-credential` check; see `work-tracker-diagnosis` for the
  combined, config-aware verdict used for the report-level `work_tracker`
  block. Accepts the same optional `source` arg as `work-tracker-diagnosis`."
  ([options project-id] (work-tracker-credential-diagnosis options project-id (project-connection-source options project-id)))
  ([options project-id source]
   (let [{:keys [source-label unreadable? raw-tracker path]} (work-tracker-raw-source options project-id source)]
     (or
       (work-tracker-prologue-result source-label unreadable? raw-tracker path)
       (let [{:keys [provider-name credential-ref credential-ref-str]} (work-tracker-envelope-fields raw-tracker)]
         (or
           (when-let [issue (work-tracker-ref-issue credential-ref)]
             (work-tracker-diagnosis-result (:state issue) source-label
               :provider provider-name :credential-ref credential-ref-str
               :message (:message issue) :remediation (:remediation issue)))
           (let [readiness (work-tracker-credential-readiness options project-id credential-ref)]
             (work-tracker-diagnosis-result (:state readiness) source-label
               :provider provider-name :credential-ref credential-ref-str :credential-state (:credential-state readiness)
               :message (:message readiness) :remediation (:remediation readiness)))))))))

(defn update-project-connections
  ([] (update-project-connections {} nil nil))
  ([options project-id updates]
   (let [updates (or updates {})]
     (cond
       (not (map? updates))
       (error-response 400 "bad_request" "connections update must be an object")

       (contains-raw-secret-key? updates)
       ;; Raw secret payloads are NEVER accepted; only refs + config.
       (error-response 400 "bad_request"
                      "Raw secret payloads are not accepted; provide a credential-ref instead")

       :else
       (let [updates* (normalize-keys-shallow updates)
             clear-work-tracker? (or (= :clear (:work-tracker updates*))
                                     (= "clear" (:work-tracker updates*))
                                     (true? (:clear-work-tracker updates*)))
             validation-updates (cond-> (dissoc updates* :clear-work-tracker)
                                  clear-work-tracker? (dissoc :work-tracker))]
         (if-let [err (validate-connections validation-updates "project")]
           (error-response 400 "bad_request" err)
           (let [resolved (resolve-project options project-id)]
             (if (:error resolved)
               resolved
               (let [pid (or project-id "default")
                     target (durable-project-write-target options pid)]
                 (if (:error target)
                   target
                   (let [current (if (seq (:current target))
                                   (:current target)
                                   (-> (synthesize-default-project options) (dissoc :source)))
                         normalized-updates (normalize-connections validation-updates)
                         merged-conn (cond-> (merge (:connections current {}) normalized-updates)
                                       clear-work-tracker? (dissoc :work-tracker))
                         manifest (assoc current :connections merged-conn)
                         writable (if (= :descriptor (:kind target))
                                    (portable-descriptor-write-shape pid manifest)
                                    manifest)]
                     (fs/create-dirs (fs/parent (:path target)))
                     (safe-write/write-json! (:path target) writable
                                             {:owner-only? (= :registry (:kind target))})
                     (get-project-connections options project-id))))))))))))

(defn project-context-opts
  "Build project-scoped options from an already resolved project context.
  Ephemeral options such as `:credential-resolver` are preserved."
  [options project]
  (let [base (opts options)
        control-ws (:workspace-root base)]
    (-> base
        (assoc :workspace-root (str (abs-path control-ws (:workspace_root project)))
               :runs-root (:runs_root project))
        (assoc :workflow-roots (or (get-in project [:discovery :workflow-roots])
                                   (:workflow-roots base))
               :tesseraft-home (or (get-in project [:discovery :tesseraft-home])
                                    (:tesseraft-home base))))))

(defn project-scoped-opts
  "Build per-call options resolved from a project. The project's
  `:workspace_root`/`:runs_root`/discovery roots are relative to the control
  workspace (where project manifests live), so `:workspace_root` is resolved
  against `(:workspace-root opts)` via `abs-path` — never replaced with a
  bare relative path that would silently relocate discovery to the process
  cwd. `:runs_root` stays relative (resolved by `run-state-files` against
  the now-absolutized workspace root). If the project can't be resolved,
  returns its structured error. The `default` project's `workspace_root` is
  `.` (the control workspace), preserving existing single-project behavior."
  ([options] (project-scoped-opts options nil))
  ([options project-id]
   (let [project (resolve-project options project-id)]
     (if (:error project)
       project
       (project-context-opts options project)))))
