(ns tesseraft.lint.core
  (:require
    [tesseraft.spec :as spec]
    [babashka.fs :as fs]
    [clojure.set :as set]
    [clojure.string :as str]))

(defn diag
  ([severity code path message] (diag severity code path message nil))
  ([severity code path message hint]
   (cond-> {:severity (name severity)
            :code (name code)
            :path (mapv #(if (keyword? %) (name %) %) path)
            :message message}
     hint (assoc :hint hint))))
(defn err
  ([code path message] (diag :error code path message))
  ([code path message hint] (diag :error code path message hint)))
(defn warn
  ([code path message] (diag :warning code path message))
  ([code path message hint] (diag :warning code path message hint)))
(defn info [code path message] (diag :info code path message))

(defn known-handlers [opts]
  (set (concat spec/default-known-handlers (:known-handlers opts))))
(defn known-executors [opts]
  (set (concat spec/default-known-executors (:known-executors opts))))
(defn allowed-tools [wf opts]
  (set (concat spec/base-pi-tools
               (get-in wf [:policies :allowed-agent-tools] [])
               (:allowed-tools opts))))

(defn optional-nonblank-string-check [code path field value]
  (when (and (some? value)
             (or (not (string? value)) (str/blank? value)))
    [(err code path (str "Agent node " field " must be a non-blank string when present"))]))

(def ^:private pi-thinking-levels
  #{"off" "minimal" "low" "medium" "high" "xhigh"})

(defn agent-thinking-check [path value]
  (when (and (some? value) (not (contains? pi-thinking-levels value)))
    [(err :invalid-agent-thinking path
          (str "Agent node :thinking must be one of "
               (str/join ", " (sort pi-thinking-levels))))]))

(defn top-level-checks [wf]
  (let [required [:api-version :kind :metadata :initial :states]]
    (concat
      (for [k required :when (not (contains? wf k))]
        (err :missing-top-level-key [k] (str "Missing required top-level key " k)))
      (when (and (:api-version wf) (not (contains? spec/supported-api-versions (:api-version wf))))
        [(err :unsupported-api-version [:api-version]
              (str "Unsupported api-version " (pr-str (:api-version wf))))])
      (when (and (:kind wf) (not= spec/supported-kind (:kind wf)))
        [(err :unsupported-kind [:kind] (str "Unsupported kind " (pr-str (:kind wf))))])
      (when (and (:metadata wf) (not (map? (:metadata wf))))
        [(err :metadata-not-map [:metadata] ":metadata must be a map")])
      (when (and (map? (:metadata wf)) (str/blank? (str (get-in wf [:metadata :name]))))
        [(err :metadata-missing-name [:metadata :name] "Workflow metadata must include :name")])
      (when (and (:states wf) (not (map? (:states wf))))
        [(err :states-not-map [:states] ":states must be a map of state-id to node config")])
      (when (and (map? (:states wf)) (empty? (:states wf)))
        [(err :empty-states [:states] ":states must contain at least one node")])
      (when (and (:initial wf) (map? (:states wf)) (not (contains? (:states wf) (:initial wf))))
        [(err :missing-initial-state [:initial] (str "Initial state does not exist: " (:initial wf)))])
      (when (and (map? (:states wf)) (empty? (spec/terminal-ids wf)))
        [(err :missing-terminal-state [:states] "Workflow must declare at least one :terminal node")]))))

(defn node-type-checks [wf]
  (apply concat
         (for [[id n] (:states wf)]
           (concat
             (when-not (map? n)
               [(err :node-not-map [:states id] "Node config must be a map")])
             (when (map? n)
               (let [t (:type n)]
                 (concat
                   (when-not t [(err :missing-node-type [:states id :type] "Node is missing :type")])
                   (when (and t (not (contains? spec/valid-node-types t)))
                     [(err :unknown-node-type [:states id :type] (str "Unknown node type " t))]))))))))

(defn transition-checks [wf]
  (let [ids (spec/node-ids wf)]
    (apply concat
           (for [[id n] (:states wf)]
             (concat
               (when (and (not= :terminal (:type n)) (empty? (spec/transitions n)))
                 [(err :dead-end-non-terminal [:states id]
                       "Non-terminal node has no :next or :transitions")])
               (when (and (:next n) (:transitions n))
                 [(warn :next-and-transitions [:states id]
                        "Node has both :next and :transitions; :transitions takes precedence")])
               (for [[idx tr] (map-indexed vector (spec/transitions n))]
                 (cond
                   (nil? (:next tr))
                   (err :transition-missing-next [:states id :transitions idx :next] "Transition is missing :next")

                   (not (contains? ids (:next tr)))
                   (err :unknown-next-state [:states id :transitions idx :next]
                        (str "Transition points to missing state: " (:next tr)))

                   :else nil))
               (for [[idx tr] (map-indexed vector (spec/transitions n))
                     effect (:effects tr [])
                     :when (not (contains? spec/known-effects effect))]
                 (err :unknown-effect [:states id :transitions idx :effects]
                      (str "Unknown transition effect: " effect))))))))

(defn reachability-checks [wf]
  (when (and (:initial wf) (map? (:states wf)))
    (let [reachable (spec/reachable-states wf)
          all (spec/node-ids wf)]
      (for [id (sort-by name (remove reachable all))]
        (warn :unreachable-state [:states id]
              (str "State is unreachable from initial state: " id))))))

(defn normalize-resource-value [x]
  (cond
    (keyword? x) (name x)
    (string? x) x
    :else x))

(defn normalize-resource-mode [mode]
  (when (or (keyword? mode) (string? mode))
    (keyword (normalize-resource-value mode))))

(defn duplicate-resource-key [group resource]
  (mapv normalize-resource-value [group (:kind resource) (:name resource) (:path resource)]))

(defn resource-entry-checks [group path resource]
  (if-not (map? resource)
    [(err :resource-not-map path "Resource declaration must be a map")]
    (concat
      (when-not (contains? resource :kind)
        [(err :resource-missing-kind (conj path :kind)
              "Resource declaration must include :kind")])
      (when-not (contains? resource :name)
        [(err :resource-missing-name (conj path :name)
              "Resource declaration must include :name")])
      (for [field (keys resource)
            :when (not (contains? spec/resource-fields field))]
        (err :resource-unknown-field (conj path field)
             (str "Unknown resource field " field)))
      (when (and (contains? resource :mode)
                 (not (contains? spec/resource-modes (normalize-resource-mode (:mode resource)))))
        [(warn :resource-unknown-mode (conj path :mode)
               (str "Unknown resource mode " (:mode resource)))])
      (when (and (contains? resource :path)
                 (not (spec/safe-relative-path? (:path resource))))
        [(err :invalid-resource-path (conj path :path)
              (str "Resource paths must be safe relative paths: " (:path resource)))])
      (when (and (= group :produces)
                 (contains? resource :schema)
                 (not (spec/safe-relative-path? (:schema resource))))
        [(err :invalid-resource-path (conj path :schema)
              (str "Resource schemas must be safe relative paths: " (:schema resource)))]))))

(defn resource-group-checks [base-path group entries]
  (if-not (vector? entries)
    [(err :resource-group-not-vector (conj base-path group)
          (str "Resource group " group " must be a vector"))]
    (let [entry-diags (apply concat
                             (for [[idx resource] (map-indexed vector entries)]
                               (resource-entry-checks group (conj base-path group idx) resource)))
          duplicates (->> entries
                          (filter map?)
                          (group-by #(duplicate-resource-key group %))
                          (filter (fn [[_ xs]] (> (count xs) 1))))]
      (concat
        entry-diags
        (for [[k _] duplicates]
          (warn :duplicate-resource-declaration (conj base-path group)
                (str "Duplicate resource declaration " (pr-str k))))))))

(defn resource-declaration-checks [base-path resources]
  (cond
    (nil? resources) []
    (not (map? resources)) [(err :resources-not-map base-path ":resources must be a map")]
    :else
    (concat
      (for [group (keys resources)
            :when (not (contains? spec/resource-groups group))]
        (warn :resource-unknown-group (conj base-path group)
              (str "Unknown resource group " group "; expected one of :requires, :consumes, or :produces")))
      (apply concat
             (for [group spec/resource-groups
                   :when (contains? resources group)]
               (resource-group-checks base-path group (get resources group)))))))

(def ambient-resource-kinds
  #{:asset :prompt-template
    :capability :tool :handler :executor :secret :policy :policies
    :run-state})

(def service-resource-kinds
  #{:service :web-service :test-server :endpoint :service-endpoint})

(defn resource-identity [resource]
  (when (and (map? resource) (contains? resource :kind) (contains? resource :name))
    (let [kind (keyword (normalize-resource-value (:kind resource)))
          name (normalize-resource-value (:name resource))]
      (if (contains? resource :path)
        [kind name (normalize-resource-value (:path resource))]
        [kind name]))))

(defn resource-label [resource]
  (let [id (resource-identity resource)]
    (if (seq id)
      (str/join "/" (map str id))
      (pr-str resource))))

(defn resource-availability-ids [resource]
  (when-let [id (resource-identity resource)]
    #{id}))

(defn resource-available? [available resource]
  (boolean (some available (resource-availability-ids resource))))

(defn ambient-resource? [resource]
  (contains? ambient-resource-kinds (keyword (normalize-resource-value (:kind resource)))))

(def input-resource-aliases
  {:prompt #{"user-prompt"}})

(defn binding-resource-ids [kind binding-key binding]
  (let [binding-name (normalize-resource-value binding-key)
        explicit-names (when (map? binding)
                         (keep #(some-> (get binding %) normalize-resource-value)
                               [:name :resource-name]))
        names (concat [binding-name]
                      explicit-names
                      (get input-resource-aliases (keyword binding-key)))
        path (when (map? binding)
               (some-> (:path binding) normalize-resource-value))]
    (set (concat
           (map #(vector kind %) names)
           (when path
             (map #(vector kind % path) names))))))

(defn workflow-ambient-resource-ids [wf]
  (set (concat
         (mapcat (fn [[k v]] (binding-resource-ids :input k v)) (:inputs wf))
         (mapcat (fn [[k v]] (binding-resource-ids :default k v)) (:defaults wf)))))

(defn one-shot-consume? [resource]
  (let [mode (normalize-resource-mode (:mode resource))
        kind (keyword (normalize-resource-value (:kind resource)))]
    (cond
      (contains? #{:read :reusable} mode) false
      (contains? #{:one-shot :write :read-write} mode) true
      (contains? service-resource-kinds kind) true
      :else false)))

(defn workflow-resource-shape-checks [wf]
  (apply concat
         (for [[id n] (:states wf)
               :when (map? n)]
           (resource-declaration-checks [:states id :resources] (:resources n)))))

(defn resource-flow-predecessors [wf]
  (reduce-kv (fn [preds id targets]
               (reduce (fn [m target] (update m target (fnil conj #{}) id)) preds targets))
             {}
             (spec/graph wf)))

(defn merge-resource-states [states]
  (let [states (vec (remove nil? states))]
    (when (seq states)
      {:available (apply set/intersection (map :available states))
       :consumed (apply set/union (map :consumed states))})))

(defn add-available-resource [state resource]
  (reduce (fn [s id]
            (-> s
                (update :available conj id)
                (update :consumed disj id)))
          state
          (resource-availability-ids resource)))

(defn remove-available-resource [state resource]
  (reduce (fn [s id] (update s :available disj id))
          state
          (resource-availability-ids resource)))

(defn mark-consumed-resource [state resource]
  (reduce (fn [s id] (update s :consumed conj id))
          state
          (resource-availability-ids resource)))

(defn transfer-resource-state [node state]
  (let [resources (:resources node {})]
    (reduce add-available-resource
            (reduce (fn [s resource]
                      (if (one-shot-consume? resource)
                        (-> s
                            (remove-available-resource resource)
                            (mark-consumed-resource resource))
                        s))
                    state
                    (:consumes resources []))
            (:produces resources []))))

(defn resource-flow-states [wf]
  (let [ids (spec/reachable-states wf)
        preds (resource-flow-predecessors wf)
        initial (:initial wf)
        initial-state {:available (workflow-ambient-resource-ids wf) :consumed #{}}
        max-passes (max 1 (* 20 (max 1 (count ids))))]
    (loop [pass 0 out-states {}]
      (let [in-state (fn [id]
                       (merge-resource-states
                         (concat
                           (when (= id initial) [initial-state])
                           (map out-states (get preds id #{})))))
            next-out (into {}
                           (keep (fn [id]
                                   (when-let [state (in-state id)]
                                     [id (transfer-resource-state (get-in wf [:states id]) state)])))
                           ids)]
        (cond
          (= next-out out-states) {:states next-out :converged true}
          (>= pass max-passes) {:states next-out :converged false}
          :else (recur (inc pass) next-out))))))

(defn reachable-from [graph start]
  (loop [seen #{} stack [start]]
    (if-let [id (peek stack)]
      (if (or (nil? id) (seen id))
        (recur seen (pop stack))
        (recur (conj seen id) (into (pop stack) (get graph id))))
      seen)))

(defn cyclic-resource-components [wf]
  (let [graph (spec/graph wf)
        ids (spec/reachable-states wf)
        reachability (into {} (map (fn [id] [id (reachable-from graph id)])) ids)]
    (->> ids
         (map (fn [id]
                (set (filter #(contains? (get reachability %) id)
                             (get reachability id)))))
         (filter (fn [component]
                   (or (> (count component) 1)
                       (contains? (get graph (first component)) (first component)))))
         set)))

(defn resource-cycle-diagnostics [wf]
  (apply concat
         (for [component (cyclic-resource-components wf)
               :let [produced (set (mapcat (fn [id]
                                             (keep resource-identity
                                                   (get-in wf [:states id :resources :produces])))
                                           component))]
               id component
               [idx resource] (map-indexed vector (get-in wf [:states id :resources :consumes] []))
               :let [rid (resource-identity resource)]
               :when (and rid
                          (one-shot-consume? resource)
                          (not (contains? produced rid)))]
           [(warn :resource-cycle-conservative
                  [:states id :resources :consumes idx]
                  (str "Node " id " consumes one-shot resource " (resource-label resource)
                       " inside a cycle, but that cycle does not produce a fresh matching resource before reuse can be proven")
                  "Move the one-shot consume outside the cycle, produce a fresh resource identity inside the cycle before each consume, or mark read-only/reusable access with :mode :read or :mode :reusable.")])))

(defn resource-node-diagnostics [id node state]
  (let [available (:available state)
        consumed (:consumed state)
        requires (map-indexed vector (get-in node [:resources :requires] []))
        consumes (map-indexed vector (get-in node [:resources :consumes] []))]
    (concat
      (for [[idx resource] requires
            :let [rid (resource-identity resource)]
            :when (and rid
                       (not (ambient-resource? resource))
                       (not (resource-available? available resource)))]
        (err :resource-missing-producer
             [:states id :resources :requires idx]
             (str "Node " id " requires resource " (resource-label resource)
                  " but it is not produced on every path into the node")
             "Add a reachable predecessor that produces this resource, mark it as an ambient capability/input, or move this node after the producer on all branches."))
      (for [[idx resource] consumes
            :let [rid (resource-identity resource)]
            :when (and rid
                       (one-shot-consume? resource)
                       (not (resource-available? consumed resource))
                       (not (resource-available? available resource)))]
        (err :resource-missing-producer
             [:states id :resources :consumes idx]
             (str "Node " id " consumes one-shot resource " (resource-label resource)
                  " but it is not produced on every path into the node")
             "Produce the resource on all incoming paths, or mark read-only/reusable consumes with :mode :read or :mode :reusable."))
      (for [[idx resource] consumes
            :let [rid (resource-identity resource)]
            :when (and rid
                       (not (ambient-resource? resource))
                       (not (one-shot-consume? resource))
                       (not (resource-available? available resource)))]
        (err :resource-missing-producer
             [:states id :resources :consumes idx]
             (str "Node " id " consumes read-only resource " (resource-label resource)
                  " but it is not produced on every path into the node")
             "Produce the resource on all incoming paths, or declare it as an ambient capability/input when it is not produced by this workflow."))
      (for [[idx resource] consumes
            :let [rid (resource-identity resource)]
            :when (and rid
                       (one-shot-consume? resource)
                       (resource-available? consumed resource))]
        (err :resource-double-consume
             [:states id :resources :consumes idx]
             (str "Node " id " may consume one-shot resource " (resource-label resource)
                  " after it has already been consumed on an incoming path")
             "Use :mode :read or :mode :reusable for non-consuming access, or produce a fresh resource identity before consuming again.")))))

(defn resource-flow-diagnostics [wf]
  (let [{out-states :states converged? :converged} (resource-flow-states wf)
        preds (resource-flow-predecessors wf)
        initial (:initial wf)
        initial-state {:available (workflow-ambient-resource-ids wf) :consumed #{}}
        in-state (fn [id]
                   (merge-resource-states
                     (concat
                       (when (= id initial) [initial-state])
                       (map out-states (get preds id #{})))))]
    (concat
      (when-not converged?
        [(warn :resource-cycle-conservative [:states]
               "Resource flow analysis reached its iteration bound; cyclic resource availability may need explicit reusable/read modes or acyclic production before use")])
      (resource-cycle-diagnostics wf)
      (apply concat
             (for [[id node] (:states wf)
                   :let [state (in-state id)]
                   :when (and state (map? node))]
               (resource-node-diagnostics id node state))))))

(defn workflow-resource-checks [wf]
  (concat
    (workflow-resource-shape-checks wf)
    (resource-flow-diagnostics wf)))

(defn path-contract-checks [wf id node]
  (apply concat
         (for [[out-key contract] (spec/output-contracts node)]
           (let [p (spec/output-path contract)
                 schema (spec/output-schema contract)]
             (concat
               (when-not p
                 [(err :output-missing-path [:states id :outputs out-key]
                       "Output contract must be a path string or map with :path")])
               (when (and p (not (spec/safe-relative-path? p)))
                 [(err :invalid-artifact-path [:states id :outputs out-key :path]
                       (str "Artifact paths must be safe relative paths: " p))])
               (when schema
                 (let [schema-path (spec/resolve-workflow-path wf schema)]
                   (when-not (fs/exists? schema-path)
                     [(err :output-schema-missing [:states id :outputs out-key :schema]
                           (str "Declared output schema does not exist: " schema))]))))))))

(declare lint-fragment-package lint-fragment-package-cached)

;; ---- workflow :fragment node checks ----
;; A {:type :fragment} node is a boundary call to a fragment package.
;; Inclusion lints the boundary contract; internal subgraph proof is done
;; once by lint-fragment-package (surfaced here as a single aggregate
;; fragment-internal-lint-failed when the package is broken).

(defn fragment-home-dir []
  (or (System/getenv "TESSERAFT_HOME")
      (str (fs/path (System/getProperty "user.home") ".tesseraft"))))

(defn ancestor-dirs [start]
  (loop [d (fs/absolutize (fs/path (str start))) acc []]
    (let [s (str d)
          p (some-> (fs/parent d) str)]
      (cond
        (nil? p) (conj acc s)
        (= p s) (conj acc s)
        (some #{s} acc) acc
        :else (recur (fs/path p) (conj acc s))))))

(defn find-fragment-package-file [wf node]
  (when-let [name (:fragment node)]
    (let [nm (str name)
          scope (:scope node)
          home (fragment-home-dir)
          ancs (ancestor-dirs (or (spec/workflow-dir wf) "."))
          exists (fn [f] (when (fs/exists? f) (str f)))]
      (or
        ;; explicit scope directory
        (when (string? scope)
          (or (exists (fs/path scope "fragment.edn"))
              (exists (fs/path scope nm "fragment.edn"))
              (exists (fs/path scope "fragments" nm "fragment.edn"))))
        (when (#{:project} scope)
          (some exists (for [d ancs] (fs/path d ".tesseraft" "fragments" nm "fragment.edn"))))
        (when (#{:global} scope)
          (exists (fs/path home "fragments" nm "fragment.edn")))
        (when (#{:example :examples :configured} scope)
          (some exists (for [d ancs] (fs/path d "examples" "fragments" nm "fragment.edn"))))
        ;; default precedence: project > global > examples
        (some exists (for [d ancs] (fs/path d ".tesseraft" "fragments" nm "fragment.edn")))
        (exists (fs/path home "fragments" nm "fragment.edn"))
        (some exists (for [d ancs] (fs/path d "examples" "fragments" nm "fragment.edn")))))))

(defn fragment-transition-outcome [tr]
  (some-> (get-in tr [:when :fragment/outcome]) str))

(defn fragment-node-output-required? [contract]
  (cond
    (string? contract) false
    (map? contract) (not= false (:required contract))
    :else false))

(defn fragment-node-diagnostics [wf id n opts]
  (let [frag-name (:fragment n)
        path [:states id]]
    (if-let [fpath (find-fragment-package-file wf n)]
      (try
        (let [pkg (spec/read-fragment-package fpath)
              iface (:interface pkg)
              req-inputs (for [[k c] (:inputs iface {}) :when (fragment-node-output-required? c)] k)
              bound-inputs (set (keys (:inputs n {})))
              missing-inputs (remove #(contains? bound-inputs %) req-inputs)
              outcomes (set (:outcomes iface))
              covered (set (map keyword (keep fragment-transition-outcome (spec/transitions n))))]
          (concat
            (for [k missing-inputs]
              (err :fragment-input-binding-missing (conj path :inputs k)
                   (str "Fragment " frag-name " requires input " (name k) " but it is not bound")))
            ;; Boundary-only inclusion: the import site does NOT re-prove the
            ;; fragment's internal subgraph. Internal proof is done once by
            ;; `tesseraft fragment lint` and `fragment import`. We surface
            ;; at most one de-duplicated, per-file-path internal-lint signal
            ;; per lint-workflow invocation so a broken fragment is still
            ;; reported to importing workflows without N-fold re-proof.
            (let [res (lint-fragment-package-cached pkg opts)
                  fkey (spec/fragment-package-file pkg)
                  seen (::fragment-internal-seen opts)]
              (when (and (not (:ok res))
                         (or (nil? seen)
                             (not (contains? @seen fkey))))
                (when seen (swap! seen conj fkey))
                [(err :fragment-internal-lint-failed (conj path :fragment)
                      (str "Fragment package " frag-name " failed lint with " (count (:errors res)) " error(s)")
                      (str/join "; " (map :message (:errors res))))]))
            (for [o outcomes :when (not (contains? covered o))]
              (warn :fragment-uncovered-outcome (conj path :transitions)
                    (str "Fragment outcome " o " is not covered by any transition")))
            (for [o covered :when (not (contains? outcomes o))]
              (err :fragment-unknown-outcome (conj path :transitions)
                   (str "Transition references unknown fragment outcome " o)))))
        (catch Throwable t
          [(err :fragment-internal-lint-failed (conj path :fragment)
                (str "Fragment package " frag-name " could not be read: " (.getMessage t)))]))
      [(err :fragment-unknown-package (conj path :fragment)
            (str "Fragment package not found: " frag-name))])))

(defn fragment-node-checks [wf opts]
  (let [opts (-> opts
                 (assoc ::fragment-internal-cache (atom {}))
                 (assoc ::fragment-internal-seen (atom #{})))]
    (apply concat
           (for [[id n] (:states wf)
                 :when (and (map? n) (= :fragment (:type n)))]
             (fragment-node-diagnostics wf id n opts)))))

(defn node-contract-checks [wf opts]
  (apply concat
         (for [[id n] (:states wf)]
           (let [t (:type n)]
             (concat
               (path-contract-checks wf id n)
               (case t
                 :agent
                 (concat
                   (when-not (:executor n)
                     [(err :agent-missing-executor [:states id :executor]
                           "Agent node must declare :executor")])
                   (when (and (:executor n) (not (contains? (known-executors opts) (:executor n))))
                     [(err :unknown-executor [:states id :executor]
                           (str "Unknown agent executor: " (:executor n)))])
                   (optional-nonblank-string-check :invalid-agent-provider [:states id :provider] ":provider" (:provider n))
                   (optional-nonblank-string-check :invalid-agent-model [:states id :model] ":model" (:model n))
                   (agent-thinking-check [:states id :thinking] (:thinking n))
                   (when-not (:prompt-template n)
                     [(err :agent-missing-prompt-template [:states id :prompt-template]
                           "Agent node must declare :prompt-template")])
                   (when (:prompt-template n)
                     (let [p (spec/resolve-workflow-path wf (:prompt-template n))]
                       (when-not (fs/exists? p)
                         [(err :prompt-template-missing [:states id :prompt-template]
                               (str "Prompt template file does not exist: " (:prompt-template n)))])))
                   (when-not (spec/status-output-path n)
                     [(err :agent-missing-status-output [:states id :outputs :status]
                           "Agent node must declare a status output")])
                   (for [tool (:tools n)
                         :when (not (contains? (allowed-tools wf opts) tool))]
                     (warn :unknown-agent-tool [:states id :tools]
                           (str "Tool is not in the configured allowed tool set: " tool)))
                   (when (and (get-in wf [:policies :require-timeouts])
                              (nil? (get-in n [:runtime :timeout]))
                              (nil? (get-in wf [:defaults :state-timeout])))
                     [(err :missing-runtime-timeout [:states id :runtime :timeout]
                           "Policy requires a timeout for agent nodes or a default :state-timeout")]))

                 :deterministic
                 (concat
                   (when-not (:handler n)
                     [(err :deterministic-missing-handler [:states id :handler]
                           "Deterministic node must declare :handler")])
                   (when (and (:handler n) (not (contains? (known-handlers opts) (:handler n))))
                     [(err :unknown-handler [:states id :handler]
                           (str "Unknown deterministic handler: " (:handler n)))])
                   (when (and (get-in wf [:policies :require-timeouts])
                              (nil? (get-in n [:runtime :timeout]))
                              (nil? (get-in wf [:defaults :state-timeout])))
                     [(err :missing-runtime-timeout [:states id :runtime :timeout]
                           "Policy requires a timeout for deterministic nodes or a default :state-timeout")]))

                 :process
                 (concat
                   (when-not (seq (:command n))
                     [(err :process-missing-command [:states id :command]
                           "Process node must declare non-empty :command")])
                   (when (:command n)
                     (let [cmd0 (first (:command n))]
                       (when (and (string? cmd0) (or (str/includes? cmd0 "/") (str/starts-with? cmd0 ".")))
                         (let [p (spec/resolve-workflow-path wf cmd0)]
                           (when-not (fs/exists? p)
                             [(err :process-command-missing [:states id :command 0]
                                   (str "Process command file does not exist: " cmd0))])))))
                   (when (and (get-in wf [:policies :require-timeouts])
                              (nil? (get-in n [:runtime :timeout]))
                              (nil? (get-in wf [:defaults :state-timeout])))
                     [(err :missing-runtime-timeout [:states id :runtime :timeout]
                           "Policy requires a timeout for process nodes or a default :state-timeout")]))

                 :timer
                 (when-not (:duration n)
                   [(err :timer-missing-duration [:states id :duration]
                         "Timer node must declare :duration")])

                 :approval
                 (concat
                   (when-not (:message n)
                     [(err :approval-missing-message [:states id :message]
                           "Approval node must declare :message")])
                   (when (and (get-in wf [:policies :require-timeouts])
                              (nil? (:timeout n))
                              (nil? (get-in wf [:defaults :approval-timeout])))
                     [(warn :approval-missing-timeout [:states id :timeout]
                            "Approval node has no timeout")]))

                 :router []
                 :terminal []
                 []))))))

(defn duplicate-output-checks [wf]
  (let [pairs (for [[id n] (:states wf)
                    [k p] (spec/outputs-with-paths n)]
                [p {:state id :output k}])
        grouped (group-by first pairs)]
    (for [[p entries] grouped
          :when (> (count entries) 1)]
      (warn :duplicate-output-path [:states]
            (str "Multiple outputs write to " p ": "
                 (str/join ", " (map #(str (get-in % [1 :state]) "/" (get-in % [1 :output])) entries)))))))

(defn graph-has-cycle? [wf]
  (let [g (spec/graph wf)]
    (letfn [(visit [state visiting visited]
              (cond
                (visiting state) true
                (visited state) false
                :else (boolean (some #(visit % (conj visiting state) (conj visited state))
                                     (get g state)))))]
      (boolean (some #(visit % #{} #{}) (keys g))))))

(defn cycle-checks [wf]
  (when (and (graph-has-cycle? wf)
             (nil? (get-in wf [:defaults :max-rounds])))
    [(warn :cycle-without-explicit-limit [:defaults :max-rounds]
           "Workflow contains a cycle but no :defaults/:max-rounds limit")]))

(defn template-var-checks [wf]
  (let [wf-vars (spec/workflow-template-vars wf)
        prompt-vars (set (mapcat (fn [[_ n]] (when (:prompt-template n)
                                               (spec/prompt-template-vars wf (:prompt-template n))))
                                  (:states wf)))
        all-vars (set (concat wf-vars prompt-vars))
        input-keys (set (map name (keys (:inputs wf))))
        default-keys (set (map name (keys (:defaults wf))))]
    (apply concat
           (for [v all-vars]
             (let [[root field] (str/split v #"\." 2)]
               (cond
                 (not (contains? spec/allowed-template-roots root))
                 [(err :unknown-template-root [:templates]
                       (str "Unknown template variable namespace in {{" v "}}"))]

                 (and (= root "inputs") field (not (contains? input-keys field)))
                 [(warn :unknown-input-template-var [:templates]
                        (str "Template references undeclared workflow input {{" v "}}"))]

                 (and (= root "defaults") field (not (contains? default-keys field)))
                 [(warn :unknown-default-template-var [:templates]
                        (str "Template references undeclared default {{" v "}}"))]

                 (and (= root "run") field (not (contains? spec/known-run-vars field)))
                 [(warn :unknown-run-template-var [:templates]
                        (str "Template references unknown run field {{" v "}}"))]

                 :else []))))))

(defn policy-checks [wf]
  (concat
    (when (get-in wf [:policies :forbid-inline-secrets])
      (let [strings (spec/data-strings (dissoc wf :__file :__dir))
            suspicious (filter #(re-find #"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s\}]+" %) strings)]
        (for [s suspicious]
          (err :possible-inline-secret [:policies :forbid-inline-secrets]
               (str "Possible inline secret in workflow data: " (subs s 0 (min (count s) 80)))))))
    (when (and (get-in wf [:policies :require-max-rounds])
               (nil? (get-in wf [:defaults :max-rounds])))
      [(err :missing-max-rounds [:defaults :max-rounds]
            "Policy requires :defaults/:max-rounds")])) )

(defn lint-workflow
  ([wf] (lint-workflow wf {}))
  ([wf opts]
   (let [diagnostics (vec (remove nil?
                                  (concat
                                    (top-level-checks wf)
                                    (node-type-checks wf)
                                    (transition-checks wf)
                                    (reachability-checks wf)
                                    (node-contract-checks wf opts)
                                    (fragment-node-checks wf opts)
                                    (duplicate-output-checks wf)
                                    (workflow-resource-checks wf)
                                    (cycle-checks wf)
                                    (template-var-checks wf)
                                    (policy-checks wf))))
         strict? (:strict opts)
         errors (filter #(or (= "error" (:severity %))
                             (and strict? (= "warning" (:severity %)))) diagnostics)
         warnings (filter #(= "warning" (:severity %)) diagnostics)]
     {:ok (empty? errors)
      :workflow (spec/workflow-file wf)
      :errors (vec errors)
      :warnings (vec warnings)
      :diagnostics diagnostics})))

(defn lint-file
  ([workflow-file] (lint-file workflow-file {}))
  ([workflow-file opts]
   (try
     (let [wf (spec/read-workflow workflow-file)]
       (lint-workflow wf opts))
     (catch Throwable t
       {:ok false
        :workflow (str workflow-file)
        :errors [(err :parse-error [] (.getMessage t))]
        :warnings []
        :diagnostics [(err :parse-error [] (.getMessage t))]}))))

(defn node-package-top-level-checks [pkg]
  (let [required [:api-version :kind :metadata :node]]
    (concat
      (for [k required :when (not (contains? pkg k))]
        (err :missing-top-level-key [k] (str "Missing required top-level key " k)))
      (when (and (:api-version pkg) (not (contains? spec/supported-node-api-versions (:api-version pkg))))
        [(err :unsupported-api-version [:api-version]
              (str "Unsupported api-version " (pr-str (:api-version pkg))))])
      (when (and (:kind pkg) (not= spec/supported-node-kind (:kind pkg)))
        [(err :unsupported-kind [:kind] (str "Unsupported kind " (pr-str (:kind pkg))))])
      (when (and (:metadata pkg) (not (map? (:metadata pkg))))
        [(err :metadata-not-map [:metadata] ":metadata must be a map")])
      (when (and (map? (:metadata pkg)) (str/blank? (str (get-in pkg [:metadata :name]))))
        [(err :metadata-missing-name [:metadata :name] "Node package metadata must include :name")])
      (when (and (:node pkg) (not (map? (:node pkg))))
        [(err :node-not-map [:node] ":node must be a map")]))))

(defn asset-paths [pkg]
  (for [[asset-kind paths] (:assets pkg {})
        :when (sequential? paths)
        path paths]
    [asset-kind path]))

(defn declared-asset-paths [pkg]
  (set (map second (asset-paths pkg))))

(defn path-like-command? [cmd]
  (and (string? cmd) (or (str/includes? cmd "/") (str/starts-with? cmd "."))))

(defn node-referenced-assets [node]
  (set (remove nil?
               (concat
                 [(:prompt-template node)]
                 (when-let [cmd (first (:command node))]
                   (when (path-like-command? cmd) [cmd]))
                 (keep (fn [[_ contract]] (spec/output-schema contract))
                       (spec/output-contracts node))))))

(defn node-package-asset-checks [pkg]
  (let [declared (declared-asset-paths pkg)
        referenced (node-referenced-assets (:node pkg))]
    (concat
      (apply concat
             (for [[asset-kind path] (asset-paths pkg)]
               (concat
                 (when-not (spec/safe-relative-path? path)
                   [(err :invalid-asset-path [:assets asset-kind]
                         (str "Asset paths must be safe relative paths: " path))])
                 (when (and (spec/safe-relative-path? path)
                            (not (fs/exists? (spec/resolve-node-package-path pkg path))))
                   [(err :asset-missing [:assets asset-kind]
                         (str "Declared asset does not exist: " path))]))))
      (for [path referenced
            :when (and path (not (contains? declared path)))]
        (warn :referenced-asset-not-declared [:assets]
              (str "Node references an asset that is not declared in :assets: " path))))))

(defn node-package-node-checks [pkg opts]
  (let [node (:node pkg)
        t (:type node)]
    (when (map? node)
      (concat
        (when-not t [(err :missing-node-type [:node :type] "Node is missing :type")])
        (when (and t (not (contains? spec/valid-node-types t)))
          [(err :unknown-node-type [:node :type] (str "Unknown node type " t))])
        (path-contract-checks pkg :node node)
        (case t
          :agent
          (concat
            (when-not (:executor node)
              [(err :agent-missing-executor [:node :executor]
                    "Agent node must declare :executor")])
            (when (and (:executor node) (not (contains? (known-executors opts) (:executor node))))
              [(err :unknown-executor [:node :executor]
                    (str "Unknown agent executor: " (:executor node)))])
            (optional-nonblank-string-check :invalid-agent-provider [:node :provider] ":provider" (:provider node))
            (optional-nonblank-string-check :invalid-agent-model [:node :model] ":model" (:model node))
            (agent-thinking-check [:node :thinking] (:thinking node))
            (when-not (:prompt-template node)
              [(err :agent-missing-prompt-template [:node :prompt-template]
                    "Agent node must declare :prompt-template")])
            (when (:prompt-template node)
              (let [p (spec/resolve-node-package-path pkg (:prompt-template node))]
                (when-not (fs/exists? p)
                  [(err :prompt-template-missing [:node :prompt-template]
                        (str "Prompt template file does not exist: " (:prompt-template node)))])))
            (when-not (spec/status-output-path node)
              [(err :agent-missing-status-output [:node :outputs :status]
                    "Agent node must declare a status output")])
            (for [tool (:tools node)
                  :when (not (contains? (allowed-tools pkg opts) tool))]
              (warn :unknown-agent-tool [:node :tools]
                    (str "Tool is not in the configured allowed tool set: " tool))))

          :deterministic
          (concat
            (when-not (:handler node)
              [(err :deterministic-missing-handler [:node :handler]
                    "Deterministic node must declare :handler")])
            (when (and (:handler node) (not (contains? (known-handlers opts) (:handler node))))
              [(err :unknown-handler [:node :handler]
                    (str "Unknown deterministic handler: " (:handler node)))]))

          :process
          (concat
            (when-not (seq (:command node))
              [(err :process-missing-command [:node :command]
                    "Process node must declare non-empty :command")])
            (when-let [cmd0 (first (:command node))]
              (when (path-like-command? cmd0)
                (let [p (spec/resolve-node-package-path pkg cmd0)]
                  (when-not (fs/exists? p)
                    [(err :process-command-missing [:node :command 0]
                          (str "Process command file does not exist: " cmd0))])))))

          :timer
          (when-not (:duration node)
            [(err :timer-missing-duration [:node :duration]
                  "Timer node must declare :duration")])

          :approval
          (when-not (:message node)
            [(err :approval-missing-message [:node :message]
                  "Approval node must declare :message")])

          :router []
          :terminal []
          [])))))

(defn node-package-template-var-checks [pkg]
  (let [node (:node pkg)
        pkg-vars (spec/workflow-template-vars pkg)
        prompt-vars (when (:prompt-template node)
                      (spec/prompt-template-vars pkg (:prompt-template node)))
        all-vars (set (concat pkg-vars prompt-vars))]
    (for [v all-vars
          :let [[root field] (str/split v #"\." 2)]
          :when (or (not (contains? spec/allowed-template-roots root))
                    (and (= root "run") field (not (contains? spec/known-run-vars field))))]
      (if (contains? spec/allowed-template-roots root)
        (warn :unknown-run-template-var [:templates]
              (str "Template references unknown run field {{" v "}}"))
        (err :unknown-template-root [:templates]
             (str "Unknown template variable namespace in {{" v "}}"))))))

(defn node-package-resource-checks [pkg]
  (concat
    (resource-declaration-checks [:requirements :resources] (get-in pkg [:requirements :resources]))
    (resource-declaration-checks [:node :resources] (get-in pkg [:node :resources]))))

(defn lint-node-package
  ([pkg] (lint-node-package pkg {}))
  ([pkg opts]
   (let [diagnostics (vec (remove nil?
                                  (concat
                                    (node-package-top-level-checks pkg)
                                    (node-package-node-checks pkg opts)
                                    (node-package-resource-checks pkg)
                                    (node-package-asset-checks pkg)
                                    (node-package-template-var-checks pkg))))
         strict? (:strict opts)
         errors (filter #(or (= "error" (:severity %))
                             (and strict? (= "warning" (:severity %)))) diagnostics)
         warnings (filter #(= "warning" (:severity %)) diagnostics)]
     {:ok (empty? errors)
      :node-package (spec/node-package-file pkg)
      :errors (vec errors)
      :warnings (vec warnings)
      :diagnostics diagnostics})))

(defn lint-node-package-file
  ([node-file] (lint-node-package-file node-file {}))
  ([node-file opts]
   (try
     (let [pkg (spec/read-node-package node-file)]
       (lint-node-package pkg opts))
     (catch Throwable t
       {:ok false
        :node-package (str node-file)
        :errors [(err :parse-error [] (.getMessage t))]
        :warnings []
        :diagnostics [(err :parse-error [] (.getMessage t))]}))))

;; ============================================================
;; Fragment package lint (tesseraft.fragment/v1)
;; ============================================================
;; A fragment package owns an internal subgraph (:fragment :states) and a
;; boundary contract (:interface). lint-fragment-package validates the
;; package once; inclusion in a workflow lints only the boundary (see
;; fragment-node-diagnostics above).

(defn fragment-package-top-level-checks [pkg]
  (let [required [:api-version :kind :metadata :interface :fragment]]
    (concat
      (for [k required :when (not (contains? pkg k))]
        (err :missing-top-level-key [k] (str "Missing required top-level key " k)))
      (when (and (:api-version pkg) (not (contains? spec/supported-fragment-api-versions (:api-version pkg))))
        [(err :unsupported-api-version [:api-version]
              (str "Unsupported api-version " (pr-str (:api-version pkg))))])
      (when (and (:kind pkg) (not= spec/supported-fragment-kind (:kind pkg)))
        [(err :unsupported-kind [:kind] (str "Unsupported kind " (pr-str (:kind pkg))))])
      (when (and (:metadata pkg) (not (map? (:metadata pkg))))
        [(err :metadata-not-map [:metadata] ":metadata must be a map")])
      (when (and (map? (:metadata pkg)) (str/blank? (str (get-in pkg [:metadata :name]))))
        [(err :metadata-missing-name [:metadata :name] "Fragment package metadata must include :name")])
      (when (and (:interface pkg) (not (map? (:interface pkg))))
        [(err :fragment-missing-interface [:interface] ":interface must be a map")])
      (when (and (:fragment pkg) (not (map? (:fragment pkg))))
        [(err :node-not-map [:fragment] ":fragment must be a map")]))))

(defn fragment-interface-checks [pkg]
  (let [iface (:interface pkg)]
    (when (map? iface)
      (let [outputs (:outputs iface {})
            outcomes (:outcomes iface)
            exit (:exit (:fragment pkg) [])
            required-outputs (set (for [[k c] outputs :when (fragment-node-output-required? c)] k))]
        (concat
          (when (or (not (contains? iface :outcomes))
                    (not (set? outcomes))
                    (empty? outcomes)
                    (not (every? keyword? outcomes)))
            [(err :fragment-outcome-mismatch [:interface :outcomes]
                  ":outcomes must be a non-empty set of keywords")])
          (when outcomes
            (let [exit-outcomes (set (keep #(some-> (:on %) keyword) exit))]
              (concat
                (for [o exit-outcomes :when (not (contains? outcomes o))]
                  (err :fragment-outcome-mismatch [:fragment :exit]
                       (str "Exit references unknown outcome: " o)))
                (for [o outcomes :when (not (contains? exit-outcomes o))]
                  (err :fragment-outcome-mismatch [:fragment :exit]
                       (str "Outcome has no exit entry: " o))))))
          (apply concat
                 (for [[idx e] (map-indexed vector exit)]
                   (let [produces (set (keys (:produces e {})))]
                     (for [ro required-outputs :when (not (contains? produces ro))]
                       (err :fragment-exit-missing-output [:fragment :exit idx :produces ro]
                            (str "Required output " ro " is not produced on exit path " (:on e))))))))))))
(defn fragment-referenced-assets [fragment]
  (set (remove nil?
               (mapcat
                 (fn [[_ n]]
                   (when (map? n)
                     (concat
                       [(:prompt-template n)]
                       (when-let [cmd (first (:command n))]
                         (when (path-like-command? cmd) [cmd]))
                       (keep (fn [[_ contract]] (spec/output-schema contract))
                             (spec/output-contracts n)))))
                 (:states fragment {})))))

(defn fragment-asset-checks [pkg]
  (let [declared (declared-asset-paths pkg)
        fragment (:fragment pkg)
        referenced (fragment-referenced-assets fragment)]
    (concat
      (apply concat
             (for [[asset-kind path] (asset-paths pkg)]
               (concat
                 (when-not (spec/safe-relative-path? path)
                   [(err :invalid-asset-path [:assets asset-kind]
                         (str "Asset paths must be safe relative paths: " path))])
                 (when (and (spec/safe-relative-path? path)
                            (not (fs/exists? (spec/resolve-fragment-package-path pkg path))))
                   [(err :fragment-asset-missing [:assets asset-kind]
                         (str "Declared asset does not exist: " path))]))))
      (for [path referenced :when (and path (not (contains? declared path)))]
        (warn :referenced-asset-not-declared [:assets]
              (str "Fragment references an asset that is not declared in :assets: " path))))))

(defn fragment-terminal-outcome-checks [pkg]
  (let [outcomes (get-in pkg [:interface :outcomes])
        fragment (:fragment pkg)
        states (:states fragment {})]
    (when (and (set? outcomes)
               (seq outcomes)
               (every? keyword? outcomes)
               (map? fragment)
               (map? states))
      (let [wf-like {:initial (:initial fragment) :states states}
            reachable (spec/reachable-states wf-like)
            reachable-terminals (for [[id n] states
                                      :when (and (contains? reachable id)
                                                 (map? n)
                                                 (= :terminal (:type n)))]
                                  [id n])
            produced-outcomes (set (for [[_ n] reachable-terminals
                                    :let [outcome (:outcome n)]
                                    :when (contains? outcomes outcome)]
                                outcome))]
        (concat
          (apply concat
                 (for [[id n] reachable-terminals]
                   (let [outcome (:outcome n)]
                     (cond
                       (nil? outcome)
                       [(err :fragment-terminal-missing-outcome [:fragment :states id :outcome]
                             (str "Terminal state " id " must select a declared fragment outcome"))]

                       (and (set? outcome) (> (count outcome) 1))
                       [(err :fragment-terminal-ambiguous-outcome [:fragment :states id :outcome]
                             (str "Terminal state " id " ambiguously selects multiple fragment outcomes " outcome))]

                       (not (contains? outcomes outcome))
                       [(err :fragment-terminal-unknown-outcome [:fragment :states id :outcome]
                             (str "Terminal state " id " selects unknown fragment outcome " outcome))]

                       :else []))))
          (for [o outcomes :when (not (contains? produced-outcomes o))]
            (err :fragment-unreachable-outcome [:interface :outcomes]
                 (str "Declared fragment outcome " o " is not produced by any reachable terminal state"))))))))

(defn fragment-internal-inputs [pkg]
  ;; The fragment's internal subgraph references boundary inputs/parameters
  ;; via template vars (e.g. {{inputs.repo-root}}). The boundary contract
  ;; lives in :interface, not on the internal "workflow-like" object, so to
  ;; run the workflow template-var/node-contract primitives meaningfully we
  ;; synthesize an :inputs map from the interface inputs AND parameters
  ;; (parameters become template vars inside the fragment too). This keeps
  ;; the valid fixture green while still catching genuinely unknown roots.
  (let [iface (:interface pkg {})
        inputs (:inputs iface {})
        params (:parameters iface {})]
    (merge inputs params)))

(defn fragment-internal-subgraph-checks [pkg opts]
  (let [fragment (:fragment pkg)
        states (:states fragment {})]
    (when (and (map? fragment) (map? states))
      ;; Build a workflow-like object so the reusable workflow linter
      ;; primitives prove the internal subgraph once, here. We carry
      ;; :__dir/:__file from the package (so prompt/schema/path resolution
      ;; resolves relative to the fragment dir, like read-workflow) and a
      ;; synthesized :inputs from the boundary interface (so template-var
      ;; checks for boundary inputs/parameters resolve). This is the
      ;; mandatory single internal proof; inclusion sites do not re-prove.
      (let [wf-like {:initial (:initial fragment)
                     :defaults (:defaults fragment)
                     :policies (:policies fragment)
                     :inputs (fragment-internal-inputs pkg)
                     :__dir (spec/fragment-package-dir pkg)
                     :__file (spec/fragment-package-file pkg)
                     :states states}]
        (concat
          (let [required [:initial :states]]
            (for [k required :when (not (contains? fragment k))]
              (err :missing-top-level-key [:fragment k] (str "Missing required fragment key " k))))
          (when (and (:initial fragment)
                     (map? states)
                     (not (contains? states (:initial fragment))))
            [(err :missing-initial-state [:fragment :initial]
                  (str "Initial state does not exist: " (:initial fragment)))])
          (when (and (map? states) (empty? (spec/terminal-ids wf-like)))
            [(err :missing-terminal-state [:fragment :states]
                  "Fragment must declare at least one :terminal node")])
          (node-type-checks wf-like)
          (transition-checks wf-like)
          (reachability-checks wf-like)
          (node-contract-checks wf-like opts)
          (duplicate-output-checks wf-like)
          (workflow-resource-checks wf-like)
          (cycle-checks wf-like)
          (template-var-checks wf-like)
          (apply concat
                 (for [[id n] states :when (map? n)]
                   (path-contract-checks wf-like id n))))))))

;; Per-lint-workflow-invocation cache of fragment internal lint results,
;; keyed by resolved file path, so a workflow importing the same fragment at
;; multiple sites surfaces the internal-proof signal at most once per file
;; path without re-running the internal subgraph lint on every import site.
(defn fragment-internal-cache [opts]
  (or (::fragment-internal-cache opts)
      (atom {})))

(defn lint-fragment-package-cached [pkg opts]
  (let [cache (fragment-internal-cache opts)
        key (spec/fragment-package-file pkg)]
    (if (and key (map? @cache))
      (or (get @cache key)
          (let [res (lint-fragment-package pkg opts)]
            (swap! cache assoc key res)
            res))
      (lint-fragment-package pkg opts))))

(defn fragment-resource-checks [pkg]
  (concat
    (resource-declaration-checks [:requirements :resources] (get-in pkg [:requirements :resources]))
    (resource-declaration-checks [:fragment :resources] (get-in pkg [:fragment :resources]))))

(defn lint-fragment-package
  ([pkg] (lint-fragment-package pkg {}))
  ([pkg opts]
   (let [diagnostics (vec (remove nil?
                                   (apply concat
                                     [(fragment-package-top-level-checks pkg)
                                      (fragment-interface-checks pkg)
                                      (fragment-terminal-outcome-checks pkg)
                                      (fragment-internal-subgraph-checks pkg opts)
                                      (fragment-resource-checks pkg)
                                      (fragment-asset-checks pkg)])))
         strict? (:strict opts)
         errors (filter #(or (= "error" (:severity %))
                             (and strict? (= "warning" (:severity %)))) diagnostics)
         warnings (filter #(= "warning" (:severity %)) diagnostics)]
     {:ok (empty? errors)
      :fragment-package (spec/fragment-package-file pkg)
      :errors (vec errors)
      :warnings (vec warnings)
      :diagnostics diagnostics})))

(defn lint-fragment-package-file
  ([fragment-file] (lint-fragment-package-file fragment-file {}))
  ([fragment-file opts]
   (try
     (let [pkg (spec/read-fragment-package fragment-file)]
       (lint-fragment-package pkg opts))
     (catch Throwable t
       {:ok false
        :fragment-package (str fragment-file)
        :errors [(err :parse-error [] (.getMessage t))]
        :warnings []
        :diagnostics [(err :parse-error [] (.getMessage t))]}))))
