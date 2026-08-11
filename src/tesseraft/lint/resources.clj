(ns tesseraft.lint.resources
  (:require [clojure.set :as set]
            [clojure.string :as str]
            [tesseraft.lint.diagnostics :refer [err warn]]
            [tesseraft.spec :as spec]))

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
