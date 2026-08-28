(ns tesseraft.runtime.sessions
  "Durable lifecycle authority for explicitly resumable agent sessions.

  A node activation is still bounded by node.started/node.finished. This
  namespace owns the run-local binding that lets several bounded activations
  address one exact executor session without ambient lookup."
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.string :as str]
    [tesseraft.executors.context :as executor-context]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]))

(def binding-version 1)
(def resumable-mode :resumable)

(defn resumable? [node]
  (= resumable-mode (get-in node [:session :mode])))

(defn state-string [state-id]
  (cond
    (keyword? state-id) (if-let [ns (namespace state-id)]
                          (str ns "/" (name state-id))
                          (name state-id))
    :else (str state-id)))

(defn encoded-state-id [state-id]
  (java.net.URLEncoder/encode (state-string state-id) "UTF-8"))

(defn binding-path [ctx state-id]
  (fs/path (get-in ctx [:run :dir]) "sessions" (encoded-state-id state-id) "binding.json"))

(defn binding-exists? [ctx state-id]
  (fs/exists? (binding-path ctx state-id)))

(defn read-binding [ctx state-id]
  (when (binding-exists? ctx state-id)
    (store/read-json (binding-path ctx state-id))))

(defn- portable-key [key]
  (cond
    (keyword? key) (if-let [ns (namespace key)] (str ns "/" (name key)) (name key))
    (string? key) key
    :else (str key)))

(defn- canonical-value [value]
  (cond
    (keyword? value) (portable-key value)
    (set? value) (->> value (map canonical-value) (sort-by pr-str) vec)
    (map? value) (into (sorted-map)
                       (map (fn [[key nested]] [(portable-key key) (canonical-value nested)]))
                       value)
    (sequential? value) (mapv canonical-value value)
    :else value))

(defn effective-executor [ctx node]
  (if (= "mock" (get-in ctx [:run :executor-mode]))
    "mock"
    (some-> (:executor node) name)))

(defn configuration-record [ctx state-id node]
  {:executor (effective-executor ctx node)
   :declared-executor (some-> (:executor node) name)
   :provider (:provider node)
   :model (:model node)
   :thinking (:thinking node)
   :tools (->> (:tools node []) (map portable-key) sort vec)
   :cwd (str (fs/absolutize (executor-context/runtime-cwd ctx state-id node)))
   :state (state-string state-id)
   :session (:session node)})

(defn configuration-hash [ctx state-id node]
  (str "sha256:"
       (store/sha256 (json/generate-string (canonical-value (configuration-record ctx state-id node))))))

(defn- error! [message error-type details]
  (throw (ex-info message (assoc details :error-type error-type))))

(defn- valid-session-ref? [session-ref]
  (and (map? session-ref)
       (= "id" (:kind session-ref))
       (string? (:value session-ref))
       (not (str/blank? (:value session-ref)))))

(defn assert-binding-compatible! [ctx state-id node binding]
  (let [expected-run (get-in ctx [:run :id])
        expected-state (state-string state-id)
        expected-executor (effective-executor ctx node)
        expected-hash (configuration-hash ctx state-id node)]
    (when-not (= binding-version (:version binding))
      (error! "Unsupported resumable session binding version"
              "session_binding_version_unsupported"
              {:state expected-state :version (:version binding)}))
    (when-not (= expected-run (:run_id binding))
      (error! "Resumable session binding belongs to a different run"
              "session_binding_run_mismatch"
              {:state expected-state :expected expected-run :actual (:run_id binding)}))
    (when-not (= expected-state (:state binding))
      (error! "Resumable session binding belongs to a different state"
              "session_binding_state_mismatch"
              {:state expected-state :actual (:state binding)}))
    (when-not (= expected-executor (:executor binding))
      (error! "Resumable session executor changed"
              "session_binding_executor_mismatch"
              {:state expected-state :expected expected-executor :actual (:executor binding)}))
    (when-not (= expected-hash (:configuration_hash binding))
      (error! "Resumable session configuration changed"
              "session_configuration_mismatch"
              {:state expected-state :expected expected-hash :actual (:configuration_hash binding)}))
    (when-not (and (integer? (:activation_sequence binding))
                   (pos? (:activation_sequence binding))
                   (map? (:last_activation binding)))
      (error! "Resumable session binding lifecycle data is malformed"
              "session_binding_invalid"
              {:state expected-state}))
    (when (and (or (contains? binding :session_ref)
                   (contains? #{"suspended" "closed"} (:status binding)))
               (not (valid-session-ref? (:session_ref binding))))
      (error! "Resumable session binding has no usable exact reference"
              "session_reference_invalid"
              {:state expected-state}))
    binding))

(defn- write-binding! [ctx state-id binding]
  (let [path (binding-path ctx state-id)]
    (fs/create-dirs (fs/parent path))
    (store/write-runtime-json! ctx path binding)
    binding))

(defn- prompt-base [state-id]
  (let [state (state-string state-id)
        label (-> state (str/replace #"[^A-Za-z0-9._-]+" "-") (str/replace #"^-+|-+$" ""))]
    (str (or (not-empty label) "state") "-" (subs (store/sha256 state) 0 10))))

(defn delivery-id [ctx state-id]
  (str (prompt-base state-id) "-" (get-in ctx [:run :attempt])))

(defn- prompt-fields [state-id node operation]
  (if (= :start operation)
    {:template (:prompt-template node)
     :output (or (:prompt-output node)
                 (str "prompts/generated/" (prompt-base state-id) "-{{run.attempt}}.md"))}
    {:template (get-in node [:session :continuation-prompt-template])
     :output (or (get-in node [:session :continuation-prompt-output])
                 (str "prompts/generated/" (prompt-base state-id)
                      "-continuation-{{run.attempt}}.md"))}))

(defn render-activation-prompt! [wf ctx state-id node operation delivery]
  (let [{:keys [template output]} (prompt-fields state-id node operation)
        template-path (spec/resolve-workflow-path wf template)
        context (executor-context/execution-context ctx state-id node)
        output-relative (spec/render-template-string output context)]
    (when-not (and (string? template) (fs/exists? template-path))
      (error! "Resumable session prompt template is unavailable"
              "session_prompt_template_unavailable"
              {:state (state-string state-id) :template template}))
    (when-not (spec/safe-relative-path? output-relative)
      (error! "Rendered resumable session prompt path is not run-confined"
              "session_prompt_output_unsafe"
              {:state (state-string state-id) :path output-relative}))
    (let [rendered (spec/render-template-string (slurp (str template-path)) context)
          content (str rendered
                       (when-not (str/ends-with? rendered "\n") "\n")
                       "\n<!-- tesseraft-delivery:" delivery " -->\n")
          output-path (fs/path (get-in ctx [:run :dir]) output-relative)]
      (store/write-runtime-text! ctx output-path content)
      {:absolute (str output-path)
       :relative output-relative
       :sha256 (str "sha256:" (store/sha256 content))})))

(defn activation-plan
  ([ctx state-id node binding]
   (activation-plan ctx state-id node binding :preallocated))
  ([ctx state-id node binding reference-allocation]
   (let [operation (if binding :resume :start)
         attempt (get-in ctx [:run :attempt])]
     (when-not (contains? #{:preallocated :executor-emitted} reference-allocation)
       (error! "Executor has no valid session reference allocation mode"
               "session_reference_allocation_invalid"
               {:state (state-string state-id) :allocation reference-allocation}))
     (when binding
       (assert-binding-compatible! ctx state-id node binding)
       (when-not (= "suspended" (:status binding))
         (error! "Resumable session is not at a safe suspended boundary"
                 "session_not_suspended"
                 {:state (state-string state-id) :status (:status binding)})))
     (let [sequence (if binding (inc (:activation_sequence binding)) 1)
           session-ref (or (:session_ref binding)
                           (when (= :preallocated reference-allocation)
                             {:kind "id" :value (str (java.util.UUID/randomUUID))}))]
       (cond-> {:operation operation
                :attempt attempt
                :activation-sequence sequence
                :delivery-id (delivery-id ctx state-id)}
         session-ref (assoc :session-ref session-ref))))))

(defn- public-event-fields [binding]
  (cond-> {:state (:state binding)
           :attempt (get-in binding [:last_activation :attempt])
           :executor (:executor binding)
           :activation_sequence (:activation_sequence binding)
           :delivery_id (get-in binding [:last_activation :delivery_id])
           :prompt_file (get-in binding [:last_activation :prompt_file])
           :prompt_sha256 (get-in binding [:last_activation :prompt_sha256])
           :configuration_hash (:configuration_hash binding)}
    (valid-session-ref? (:session_ref binding))
    (assoc :session_ref_sha256
           (str "sha256:" (store/sha256 (get-in binding [:session_ref :value]))))))

(defn begin-activation! [wf ctx state-id node reference-allocation]
  (let [prior (read-binding ctx state-id)
        plan (activation-plan ctx state-id node prior reference-allocation)
        prompt (render-activation-prompt! wf ctx state-id node (:operation plan) (:delivery-id plan))
        now (store/now)
        activation {:attempt (:attempt plan)
                    :operation (name (:operation plan))
                    :delivery_id (:delivery-id plan)
                    :prompt_file (:relative prompt)
                    :prompt_sha256 (:sha256 prompt)
                    :status "allocated"
                    :started_at now}
        allocated (if prior
                    (-> prior
                        (assoc :status "allocated"
                               :activation_sequence (:activation-sequence plan)
                               :last_activation activation
                               :updated_at now))
                    (cond-> {:version binding-version
                             :run_id (get-in ctx [:run :id])
                             :state (state-string state-id)
                             :executor (effective-executor ctx node)
                             :status "allocated"
                             :configuration_hash (configuration-hash ctx state-id node)
                             :activation_sequence 1
                             :last_activation activation
                             :created_at now
                             :updated_at now}
                      (:session-ref plan) (assoc :session_ref (:session-ref plan))))
        _ (write-binding! ctx state-id allocated)
        _ (when (= :start (:operation plan))
            (store/event! ctx (merge {:event "session.allocated"}
                                     (public-event-fields allocated))))
        active (-> allocated
                   (assoc :status "active" :updated_at (store/now))
                   (assoc-in [:last_activation :status] "active"))]
    (write-binding! ctx state-id active)
    (store/event! ctx (merge {:event "session.activation.started"
                              :operation (name (:operation plan))}
                             (public-event-fields active)))
    {:binding active
     :request (cond-> {:operation (:operation plan)
                       :prompt-file (:absolute prompt)
                       :delivery-id (:delivery-id plan)
                       :activation-sequence (:activation-sequence plan)}
                (:session-ref plan) (assoc :session-ref (:session-ref plan)))}))

(defn- bind-returned-reference! [ctx state-id binding result]
  (let [expected (:session_ref binding)
        returned (:session-ref result)]
    (when-not (valid-session-ref? returned)
      (error! "Executor did not return a usable resumable session reference"
              "session_reference_missing"
              {:state (:state binding) :executor (:executor binding)}))
    (when-not (= expected returned)
      (when expected
        (error! "Executor returned a different resumable session reference"
                "session_reference_mismatch"
                {:state (:state binding) :executor (:executor binding)})))
    (if expected
      binding
      (write-binding! ctx state-id
                      (assoc binding :session_ref returned :updated_at (store/now))))))

(defn finish-activation! [ctx state-id binding]
  (when-not (valid-session-ref? (:session_ref binding))
    (error! "Resumable session cannot suspend without an exact reference"
            "session_reference_missing"
            {:state (:state binding) :executor (:executor binding)}))
  (let [now (store/now)
        suspended (-> binding
                      (assoc :status "suspended" :updated_at now)
                      (assoc-in [:last_activation :status] "finished")
                      (assoc-in [:last_activation :finished_at] now))]
    (write-binding! ctx state-id suspended)
    (store/event! ctx (merge {:event "session.activation.finished"}
                             (public-event-fields suspended)))
    (store/event! ctx (merge {:event "session.suspended"}
                             (public-event-fields suspended)))
    suspended))

(defn orphan-activation! [ctx state-id binding error-type]
  (let [now (store/now)
        orphaned (-> binding
                     (assoc :status "orphaned" :updated_at now)
                     (assoc-in [:last_activation :status] "orphaned")
                     (assoc-in [:last_activation :finished_at] now)
                     (assoc-in [:last_activation :error_type] (or error-type "session_activation_ambiguous")))]
    (write-binding! ctx state-id orphaned)
    (store/event! ctx (merge {:event "session.orphaned"
                              :error_type (or error-type "session_activation_ambiguous")}
                             (public-event-fields orphaned)))
    orphaned))

(defn run-activation!
  "Run one explicit session start/resume activation. `invoke` receives the
  normalized request and must return the exact :session-ref. `complete` owns
  status/output validation; the binding is suspended only after it succeeds."
  [wf ctx state-id node reference-allocation invoke complete]
  (let [{:keys [binding request]} (begin-activation! wf ctx state-id node reference-allocation)
        current-binding (atom binding)]
    (try
      (let [adapter-result (invoke request)]
        (when-not (map? adapter-result)
          (error! "Executor returned a malformed session result"
                  "session_executor_result_invalid"
                  {:state (state-string state-id)}))
        (reset! current-binding
                (bind-returned-reference! ctx state-id binding adapter-result))
        (let [result (complete adapter-result)
              suspended (finish-activation! ctx state-id @current-binding)]
          (-> result
              (dissoc :session-ref)
              (assoc :session-operation (name (:operation request))
                     :session-activation-sequence (:activation_sequence suspended)
                     :session-ref-sha256 (str "sha256:"
                                              (store/sha256 (get-in suspended [:session_ref :value])))))))
      (catch Throwable t
        (let [data (ex-data t)
              error-type (or (:error-type data) (:error_type data) "session_activation_ambiguous")]
          (try
            (orphan-activation! ctx state-id @current-binding error-type)
            (catch Throwable _ nil)))
        (throw t)))))

(defn recover-completed-activation! [ctx state-id node]
  (let [binding (read-binding ctx state-id)
        attempt (get-in ctx [:run :attempt])]
    (when-not binding
      (error! "Completed resumable output has no durable session binding"
              "session_binding_missing"
              {:state (state-string state-id) :attempt attempt}))
    (assert-binding-compatible! ctx state-id node binding)
    (when-not (valid-session-ref? (:session_ref binding))
      (orphan-activation! ctx state-id binding "session_reference_missing")
      (error! "Completed resumable activation has no exact session reference"
              "session_reference_missing"
              {:state (state-string state-id) :attempt attempt}))
    (when-not (= attempt (get-in binding [:last_activation :attempt]))
      (error! "Completed resumable output does not match the bound activation"
              "session_activation_attempt_mismatch"
              {:state (state-string state-id)
               :attempt attempt
               :bound-attempt (get-in binding [:last_activation :attempt])}))
    (case (:status binding)
      "active"
      (let [now (store/now)
            recovered (-> binding
                          (assoc :status "suspended" :updated_at now)
                          (assoc-in [:last_activation :status] "finished")
                          (assoc-in [:last_activation :finished_at] now)
                          (assoc-in [:last_activation :recovered] true))]
        (write-binding! ctx state-id recovered)
        (store/event! ctx (merge {:event "session.activation.finished" :recovered true}
                                 (public-event-fields recovered)))
        (store/event! ctx (merge {:event "session.suspended" :recovered true}
                                 (public-event-fields recovered)))
        recovered)

      "suspended" binding

      (error! "Completed resumable output has no recoverable active binding"
              "session_recovery_binding_invalid"
              {:state (state-string state-id) :status (:status binding)}))))

(defn orphan-active-activation! [ctx state-id]
  (when-let [binding (read-binding ctx state-id)]
    (when (contains? #{"allocated" "active"} (:status binding))
      (orphan-activation! ctx state-id binding "session_activation_interrupted"))))

(defn- binding-files [ctx]
  (let [root (fs/path (get-in ctx [:run :dir]) "sessions")]
    (if (fs/exists? root)
      (vec (fs/glob root "*/binding.json"))
      [])))

(defn orphan-active-bindings! [ctx]
  (doseq [path (binding-files ctx)
          :let [binding (store/read-json path)]
          :when (contains? #{"allocated" "active"} (:status binding))]
    (orphan-activation! ctx (:state binding) binding "session_activation_cancelled"))
  ctx)

(defn close-bindings! [ctx]
  (doseq [path (binding-files ctx)
          :let [binding (store/read-json path)
                state-id (:state binding)]]
    (case (:status binding)
      "closed" nil
      "suspended"
      (let [now (store/now)
            closed (assoc binding :status "closed" :closed_at now :updated_at now)]
        (write-binding! ctx state-id closed)
        (store/event! ctx (merge {:event "session.closed"}
                                 (public-event-fields closed))))
      (error! "Run cannot finish while a resumable session is not suspended"
              "session_not_suspendable_at_run_finish"
              {:state state-id :status (:status binding)})))
  ctx)
