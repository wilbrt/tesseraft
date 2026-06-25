(ns agent-workflow.lint.core
  (:require
    [agent-workflow.spec :as spec]
    [babashka.fs :as fs]
    [clojure.string :as str]))

(defn diag
  ([severity code path message] (diag severity code path message nil))
  ([severity code path message hint]
   (cond-> {:severity (name severity)
            :code (name code)
            :path (mapv #(if (keyword? %) (name %) %) path)
            :message message}
     hint (assoc :hint hint))))
(defn err [code path message] (diag :error code path message))
(defn warn [code path message] (diag :warning code path message))
(defn info [code path message] (diag :info code path message))

(defn known-handlers [opts]
  (set (concat spec/default-known-handlers (:known-handlers opts))))
(defn known-executors [opts]
  (set (concat spec/default-known-executors (:known-executors opts))))
(defn allowed-tools [wf opts]
  (set (concat spec/base-pi-tools
               (get-in wf [:policies :allowed-agent-tools] [])
               (:allowed-tools opts))))

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
                                    (duplicate-output-checks wf)
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
