(ns tesseraft.control-plane.workflows
  (:require
    [babashka.fs :as fs]
    [clojure.string :as str]
    [tesseraft.control-plane.common :as common]
    [tesseraft.control-plane.projects :as projects]
    [tesseraft.lint.core :as lint]
    [tesseraft.persistence.safe-write :as safe-write]
    [tesseraft.spec :as spec]))

(def opts common/opts)
(def api-value common/api-value)
(def error-response common/error-response)
(def abs-path common/abs-path)
(def relative-path common/relative-path)
(def tesseraft-home common/tesseraft-home)
(def resolve-project projects/resolve-project)
(def project-scoped-opts projects/project-scoped-opts)

(def workflow-name-re #"^[a-z][a-z0-9-]{0,62}$")

(defn- semantic-keyword [value]
  (cond
    (keyword? value) value
    (string? value) (keyword value)
    :else value))

(defn- normalize-transition [transition]
  (cond-> transition
    (contains? transition :next) (update :next semantic-keyword)
    (contains? transition :effects) (update :effects #(mapv semantic-keyword %))
    (contains? transition :when) (update :when
                                         (fn [predicate]
                                           (if (contains? predicate :fragment/outcome)
                                             (update predicate :fragment/outcome semantic-keyword)
                                             predicate)))))

(defn- normalize-node [node]
  (cond-> node
    (contains? node :type) (update :type semantic-keyword)
    (contains? node :handler) (update :handler semantic-keyword)
    (contains? node :executor) (update :executor semantic-keyword)
    (contains? node :status) (update :status semantic-keyword)
    (contains? node :tools) (update :tools #(mapv semantic-keyword %))
    (contains? node :next) (update :next semantic-keyword)
    (contains? node :transitions) (update :transitions #(mapv normalize-transition %))))

(defn normalize-wire-workflow [wire]
  (cond-> wire
    (contains? wire :kind) (update :kind semantic-keyword)
    (contains? wire :initial) (update :initial semantic-keyword)
    (contains? wire :states) (update :states
                                     (fn [states]
                                       (into {} (map (fn [[id node]] [(semantic-keyword id) (normalize-node node)]) states))))
    (get-in wire [:policies :allowed-agent-tools])
    (update-in [:policies :allowed-agent-tools] #(mapv semantic-keyword %))))

(defn- portable-value [value]
  (cond
    (keyword? value) (if-let [ns (namespace value)] (str ns "/" (name value)) (name value))
    (set? value) (mapv portable-value (sort-by str value))
    (map? value) (into {} (map (fn [[key nested]] [(if (keyword? key)
                                                     (if-let [ns (namespace key)] (str ns "/" (name key)) (name key))
                                                     (str key))
                                              (portable-value nested)])) value)
    (vector? value) (mapv portable-value value)
    (sequential? value) (mapv portable-value value)
    :else value))

(defn save!
  [{:keys [project-root name workflow]}]
  (cond
    (not (and (string? name) (re-matches workflow-name-re name)))
    {:status 400 :error {:code "bad_request" :message "Workflow name is invalid" :details {}}}
    (not (map? workflow))
    {:status 400 :error {:code "bad_request" :message "workflow must be an object" :details {}}}
    :else
    (let [package-dir (fs/path project-root ".tesseraft" "workflows" name)
          workflow-path (fs/path package-dir "workflow.edn")
          normalized (normalize-wire-workflow workflow)
          normalized (assoc-in normalized [:metadata :name] name)
          lint-input (assoc normalized :__file (str (fs/absolutize workflow-path))
                                       :__dir (str (fs/absolutize package-dir)))
          lint-result (lint/lint-workflow lint-input)]
      (if-not (:ok lint-result)
        {:status 422
         :error {:code "invalid_workflow" :message "Workflow failed semantic validation"
                 :details {:diagnostics (:diagnostics lint-result)}}}
        (do
          (safe-write/write-text! workflow-path (str (pr-str normalized) "\n"))
          {:status 200
           :workflow {:name name :path (str workflow-path)
                      :normalized (portable-value normalized)}
           :lint (select-keys lint-result [:ok :errors :warnings :diagnostics])})))))

(defn validate
  [{:keys [project-root name workflow]}]
  (if-not (map? workflow)
    {:status 400 :error {:code "bad_request" :message "workflow must be an object" :details {}}}
    (let [package-dir (fs/path project-root ".tesseraft" "workflows" name)
          normalized (-> workflow normalize-wire-workflow (assoc-in [:metadata :name] name))
          result (lint/lint-workflow (assoc normalized :__file (str (fs/path package-dir "workflow.edn"))
                                                       :__dir (str package-dir)))]
      {:status 200 :normalized (portable-value normalized)
       :lint (select-keys result [:ok :errors :warnings :diagnostics])})))
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
;; examples/catalog/fragments/<name>/fragment.edn, using the same generic
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
   (let [sopts (project-scoped-opts options project-id)]
     (if (:error sopts)
       sopts
       (let [resolved (resolve-workflow sopts name)]
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
                 (seq duplicates) (assoc-in [:workflow :duplicates] duplicates))))))))))

(defn edge-from-transition [from tr]
  (cond-> {:from (spec/normalize-id from)
           :to (spec/normalize-id (:next tr))}
    (:when tr) (assoc :condition (:when tr))
    (:effects tr) (assoc :effects (:effects tr))))

(defn get-workflow-graph
  ([] (get-workflow-graph {} nil nil))
  ([options name] (get-workflow-graph options name nil))
  ([options name project-id]
   (let [sopts (project-scoped-opts options project-id)]
     (if (:error sopts)
       sopts
       (let [resolved (resolve-workflow sopts name)]
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
                :diagnostics (:diagnostics lint-result)}))))))))
