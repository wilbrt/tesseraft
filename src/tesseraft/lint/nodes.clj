(ns tesseraft.lint.nodes
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [tesseraft.capabilities.executors :as executor-catalog]
            [tesseraft.capabilities.handlers :as handler-catalog]
            [tesseraft.lint.diagnostics :refer [err warn]]
            [tesseraft.spec :as spec]))

(defn known-handlers [opts]
  (set (concat (handler-catalog/ids) (:known-handlers opts))))
(defn known-executors [opts]
  (set (concat (executor-catalog/ids) (:known-executors opts))))
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

(def ^:private session-fields
  #{:mode :continuation-prompt-template :continuation-prompt-output})

(defn resumable-session? [node]
  (= :resumable (get-in node [:session :mode])))

(defn attempt-stamped? [path]
  (contains? (or (spec/template-vars path) #{}) "run.attempt"))

(defn session-policy-checks [path node resolve-path]
  (when (contains? node :session)
    (let [session (:session node)]
      (if-not (map? session)
        [(err :invalid-session-policy (conj path :session)
              "Agent node :session must be a map")]
        (let [mode (:mode session)
              template (:continuation-prompt-template session)
              output (:continuation-prompt-output session)
              resumable? (= :resumable mode)
              executor (:executor node)]
          (concat
            (for [field (keys session)
                  :when (not (contains? session-fields field))]
              (err :unknown-session-field (conj path :session field)
                   (str "Unknown resumable session field: " field)))
            (when-not resumable?
              [(err :invalid-session-mode (conj path :session :mode)
                    "Agent node :session :mode must be :resumable")])
            (when (or (not (string? template)) (str/blank? template))
              [(err :session-missing-continuation-prompt-template
                    (conj path :session :continuation-prompt-template)
                    "Resumable session must declare a non-blank :continuation-prompt-template")])
            (when (and (string? template) (not (str/blank? template)))
              (if-not (spec/safe-relative-path? template)
                [(err :invalid-session-continuation-prompt-path
                      (conj path :session :continuation-prompt-template)
                      (str "Continuation prompt template must be a safe relative path: " template))]
                (when-not (fs/exists? (resolve-path template))
                  [(err :session-continuation-prompt-template-missing
                        (conj path :session :continuation-prompt-template)
                        (str "Continuation prompt template does not exist: " template))])))
            (when (some? output)
              (cond
                (or (not (string? output)) (str/blank? output))
                [(err :invalid-session-continuation-prompt-output
                      (conj path :session :continuation-prompt-output)
                      "Continuation prompt output must be a non-blank string when present")]

                (not (spec/safe-relative-path? output))
                [(err :invalid-session-continuation-prompt-output
                      (conj path :session :continuation-prompt-output)
                      (str "Continuation prompt output must be a safe relative path: " output))]

                (not (attempt-stamped? output))
                [(err :session-continuation-prompt-output-not-attempt-stamped
                      (conj path :session :continuation-prompt-output)
                      "Continuation prompt output must include {{run.attempt}}")]

                :else []))
            (when (and resumable? executor
                       (not (executor-catalog/supports-session-resume? executor)))
              [(err :resumable-session-unsupported-executor (conj path :executor)
                    (str "Executor does not support resumable sessions: " executor))])
            (when resumable?
              (for [[output-key contract] (spec/output-contracts node)
                    :let [output-path (spec/output-path contract)]
                    :when (and (spec/output-required? contract)
                               output-path
                               (not (attempt-stamped? output-path)))]
                (err :resumable-session-output-not-attempt-stamped
                     (cond-> (conj path :outputs output-key)
                       (map? contract) (conj :path))
                     (str "Required resumable-session output must include {{run.attempt}}: " output-path))))))))))

(defn- qualified-opencode-model? [value]
  (and (string? value)
       (boolean (re-matches #"[^/\s]+/[^\s]+" value))))

(defn opencode-model-check [path node]
  (when (= :opencode-cli (:executor node))
    (let [provider (:provider node)
          model (:model node)
          valid-provider? (and (string? provider)
                               (boolean (re-matches #"[^/\s]+" provider)))
          qualified? (qualified-opencode-model? model)
          valid-unqualified-model? (and (string? model)
                                        (boolean (re-matches #"[^/\s]+" model)))
          model-provider (when qualified? (first (str/split model #"/" 2)))]
      (concat
        (when (and provider (not valid-provider?))
          [(err :invalid-opencode-provider (conj path :provider)
                "OpenCode :provider must not contain whitespace or '/'")])
        (when (and provider (nil? model))
          [(err :invalid-opencode-model (conj path :model)
                "OpenCode :provider requires :model")])
        (when (and model (not provider) (not qualified?))
          [(err :invalid-opencode-model (conj path :model)
                "OpenCode :model must use provider/model format when :provider is omitted")])
        (when (and provider model (not (str/includes? model "/"))
                   (not valid-unqualified-model?))
          [(err :invalid-opencode-model (conj path :model)
                "OpenCode unqualified :model must not contain whitespace")])
        (when (and provider model (str/includes? model "/") (not qualified?))
          [(err :invalid-opencode-model (conj path :model)
                "OpenCode qualified :model must use provider/model format")])
        (when (and valid-provider? qualified? (not= provider model-provider))
          [(err :opencode-provider-model-mismatch (conj path :model)
                (str "OpenCode :model provider " (pr-str model-provider)
                     " does not match :provider " (pr-str provider)))])))))

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

;; ---- workflow :fragment node checks ----
;; A {:type :fragment} node is a boundary call to a fragment package.
;; Inclusion lints the boundary contract; internal subgraph proof is done
;; once by lint-fragment-package (surfaced here as a single aggregate
;; fragment-internal-lint-failed when the package is broken).

(defn node-contract-checks [wf opts]
  (apply concat
         (for [[id n] (:states wf)]
           (let [t (:type n)]
             (concat
               (path-contract-checks wf id n)
               (when (and (contains? n :session) (not= :agent t))
                 [(err :session-policy-requires-agent [:states id :session]
                       ":session is valid only on :agent nodes")])
               (case t
                 :agent
                 (concat
                   (when-not (:executor n)
                     [(err :agent-missing-executor [:states id :executor]
                           "Agent node must declare :executor")])
                   (when (and (:executor n) (not (contains? (known-executors opts) (:executor n))))
                     [(err :unknown-executor [:states id :executor]
                           (str "Unknown agent executor: " (:executor n)))])
                   (when (and (:executor n)
                              (contains? (executor-catalog/ids) (:executor n))
                              (not (executor-catalog/dispatchable? (:executor n))))
                     [(err :executor-unavailable [:states id :executor]
                           (str "Agent executor is recognized but unavailable: " (:executor n)))])
                   (optional-nonblank-string-check :invalid-agent-provider [:states id :provider] ":provider" (:provider n))
                   (optional-nonblank-string-check :invalid-agent-model [:states id :model] ":model" (:model n))
                   (opencode-model-check [:states id] n)
                   (agent-thinking-check [:states id :thinking] (:thinking n))
                   (session-policy-checks [:states id] n #(spec/resolve-workflow-path wf %))
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
                 (let [transitions (spec/transitions n)
                       transition-decisions (->> transitions (keep #(get-in % [:when :decision])) (map str) vec)
                       presentation-decisions (->> (get-in n [:presentation :decisions]) (map :decision) (map str) vec)
                       artifacts (get-in n [:presentation :artifacts])
                       review (:review-server n)
                       reject-option (some #(when (= "reject" (str (:decision %))) %) (get-in n [:presentation :decisions]))
                       reject-transition (some #(when (= "reject" (str (get-in % [:when :decision]))) %) transitions)
                       reject-target (when-let [target (:next reject-transition)] (spec/node wf target))]
                 (concat
                   (when-not (:message n)
                     [(err :approval-missing-message [:states id :message]
                           "Approval node must declare :message")])
                   (when (empty? transition-decisions)
                     [(err :approval-missing-decision-transition [:states id :transitions]
                           "Approval node must declare at least one :decision transition")])
                   (when (and (:presentation n) (str/blank? (str (get-in n [:presentation :question]))))
                     [(err :approval-missing-question [:states id :presentation :question]
                           "Approval presentation must declare a question")])
                   (when (and (:presentation n) (not= (set transition-decisions) (set presentation-decisions)))
                     [(err :approval-decision-mismatch [:states id :presentation :decisions]
                           "Approval presentation decisions must exactly match outgoing decision transitions")])
                   (when (not= (count presentation-decisions) (count (set presentation-decisions)))
                     [(err :approval-duplicate-decision [:states id :presentation :decisions]
                           "Approval presentation decision keys must be unique")])
                   (when (and review (not= "git-diff" (some-> (:kind review) name)))
                     [(err :approval-review-kind [:states id :review-server :kind]
                           "Approval review-server kind must be :git-diff")])
                   (when (and review (not= #{"pass" "reject"} (set transition-decisions)))
                     [(err :approval-review-decisions [:states id :transitions]
                           "Git-diff review must declare exactly pass and reject decisions")])
                   (when (and review (not (:requires-message reject-option)))
                     [(err :approval-review-reject-message [:states id :presentation :decisions]
                           "Git-diff review reject must require an overall message")])
                   (when (and review (not (some #{:merge-issues} (:effects reject-transition))))
                     [(err :approval-review-feedback-effect [:states id :transitions]
                           "Git-diff review reject must apply :merge-issues")])
                   (when (and review
                              (not (and (= :agent (:type reject-target))
                                        (= :resumable (get-in reject-target [:session :mode])))))
                     [(err :approval-review-resumable-target [:states id :transitions]
                           "Git-diff review reject must target a resumable agent node")])
                   (for [[idx artifact] (map-indexed vector artifacts)
                         :when (not (spec/safe-relative-path? (:path artifact)))]
                     (err :invalid-artifact-path [:states id :presentation :artifacts idx :path]
                          (str "Approval artifact paths must be safe relative paths: " (:path artifact))))
                   (when (and (get-in wf [:policies :require-timeouts])
                              (nil? (:timeout n))
                              (nil? (get-in wf [:defaults :approval-timeout])))
                     [(warn :approval-missing-timeout [:states id :timeout]
                            "Approval node has no timeout")])))

                 :router []
                 :terminal []
                 []))))))
