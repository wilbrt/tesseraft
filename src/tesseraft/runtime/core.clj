(ns tesseraft.runtime.core
  (:require
    [tesseraft.adapters.builtin :as adapters]
    [tesseraft.executors.mock :as mock]
    [tesseraft.executors.pi-cli :as pi-cli]
    [tesseraft.lint.core :as lint]
    [tesseraft.spec :as spec]
    [tesseraft.runtime.store :as store]
    [babashka.fs :as fs]
    [babashka.process :as p]
    [cheshire.core :as json]
    [clojure.string :as str]))

(defn parse-input [s]
  (let [[k v] (str/split s #"=" 2)] [(keyword k) v]))

(defn default-branch [inputs]
  (when-let [ticket (:ticket inputs)]
    (str "feature/" (str/lower-case ticket))))

(defn init-context [wf opts]
  (let [content (slurp (spec/workflow-file wf))
        run-id (or (:run-id opts)
                   (str "run-" (-> (store/now) (str/replace #"[:.]" "-") (str/replace #"Z$" "Z"))))
        name (spec/workflow-name wf)
        run-dir (str (fs/absolutize (fs/path ".agent-runs" name run-id)))
        inputs (merge {:repo-root "."
                       :base-branch (get-in wf [:defaults :base-branch] "main")}
                      (:inputs opts))
        inputs (if (:branch inputs) inputs (assoc inputs :branch (default-branch inputs)))
        git-user-name (some-> (get-in opts [:git-user :name]) str/trim not-empty)
        git-user-email (some-> (get-in opts [:git-user :email]) str/trim not-empty)
        git-user (when (and git-user-name git-user-email)
                   {:name git-user-name :email git-user-email})
        executor-mode (when-let [executor (:executor opts)] (clojure.core/name executor))]
    {:workflow {:name name
                :file (spec/workflow-file wf)
                :version (str "sha256:" (store/sha256 content))
                :defaults (:defaults wf {})}
     :inputs inputs
     :run (cond-> {:id run-id
                  :dir run-dir
                  :state (:initial wf)
                  :status "running"
                  :round 1
                  :attempt 1
           :feedback-cycle 1
           :issues-file (str (fs/path run-dir "issues.json"))
           :created-at (store/now)
           :updated-at (store/now)}
         executor-mode (assoc :executor-mode executor-mode)
         git-user (assoc :git-user git-user))}))

(defn artifact-path [ctx p]
  (let [rendered (spec/render-template-string p ctx)]
    (if (str/starts-with? rendered "/") rendered (str (fs/path (get-in ctx [:run :dir]) rendered)))))

(defn status-result [ctx node]
  (let [p (artifact-path ctx (spec/status-output-path node))]
    (when-not (fs/exists? p) (throw (ex-info "Status artifact missing" {:path p})))
    (store/read-json p)))

(defn required-output-paths [ctx node]
  (mapv #(artifact-path ctx %) (spec/required-output-paths node)))

(defn validate-required-outputs! [ctx node]
  (doseq [p (required-output-paths ctx node)]
    (when-not (fs/exists? p)
      (throw (ex-info "Required output missing" {:path p}))))
  ctx)

(defn run-process-node! [wf ctx state-id node]
  (let [repo-root (or (get-in ctx [:inputs :repo-root]) ".")
        request {:run (:run ctx)
                 :node (assoc node :id state-id)
                 :inputs (:inputs ctx)
                 :paths {:run_dir (get-in ctx [:run :dir]) :repo_root repo-root}}
        cmd (:command node)
        result (apply p/shell {:dir (spec/workflow-dir wf)
                               :in (json/generate-string request)
                               :out :string :err :string :continue true}
                      cmd)
        log-file (str (fs/path (get-in ctx [:run :dir]) "logs" (str (name state-id) "-process-" (get-in ctx [:run :attempt]) ".log")))]
    (fs/create-dirs (fs/parent log-file))
    (spit log-file (str "COMMAND: " (str/join " " cmd) "\n\nSTDOUT:\n" (:out result) "\n\nSTDERR:\n" (:err result) "\n"))
    (if (zero? (:exit result))
      (merge {:log-file log-file}
             (if (str/blank? (:out result))
               {:ok true :status "ok"}
               (try
                 (json/parse-string (:out result) true)
                 (catch Throwable t
                   (throw (ex-info "Malformed process JSON output"
                                   {:error-type "malformed_output"
                                    :log-file log-file
                                    :stdout (:out result)
                                    :stderr (:err result)}
                                   t))))))
      {:status "error"
       :ok false
       :error-type "process_exit"
       :message (str "Process exited with code " (:exit result))
       :exit-code (:exit result)
       :log-file log-file
       :stderr (:err result)})))

(defn parse-duration-ms [s]
  (let [[_ n unit] (re-matches #"(\d+)(ms|s|m|h)" (str s))
        n (parse-long n)]
    (case unit
      "ms" n
      "s" (* n 1000)
      "m" (* n 60 1000)
      "h" (* n 60 60 1000)
      (throw (ex-info "Invalid duration" {:duration s})))))

(defn run-timer-node! [_wf _ctx _state-id node]
  (let [ms (parse-duration-ms (:duration node))]
    (Thread/sleep ms)
    {:status "ok" :slept-ms ms}))

(defn executor-mode [ctx]
  (when-let [mode (get-in ctx [:run :executor-mode])]
    (keyword mode)))

(defn mock-mode? [ctx]
  (= :mock (executor-mode ctx)))

(defn run-agent! [wf ctx state-id node]
  (if (mock-mode? ctx)
    (mock/run-agent-node! wf ctx state-id node)
    (pi-cli/run-agent-node! wf ctx state-id node)))

(defn json-compatible [x]
  (cond
    (nil? x) nil
    (or (string? x) (number? x) (boolean? x)) x
    (keyword? x) (name x)
    (map? x) (into {} (map (fn [[k v]] [(if (keyword? k) (name k) (str k)) (json-compatible v)])) x)
    (sequential? x) (mapv json-compatible x)
    :else (str x)))

(defn normalize-external-result [ctx state-id result]
  (let [error-type (or (:error_type result) (:error-type result) "runtime_failure")
        log-file (or (:log_file result) (:log-file result))
        prompt-file (or (:prompt_file result) (:prompt-file result))
        exit-code (or (:exit_code result) (:exit-code result))]
    (cond-> (merge {:ok false
                    :status "error"
                    :error_type error-type
                    :message (or (:message result) (:error result) "External node execution failed")
                    :node_id (name state-id)
                    :attempt (get-in ctx [:run :attempt])}
                   (dissoc result :error-type :log-file :prompt-file :exit-code))
      log-file (assoc :log_file log-file)
      prompt-file (assoc :prompt_file prompt-file)
      (some? exit-code) (assoc :exit_code exit-code))))

(defn external-error-result
  ([ctx state-id error] (external-error-result ctx state-id error nil))
  ([ctx state-id error details]
   (let [data (when (instance? clojure.lang.ExceptionInfo error) (ex-data error))]
     (merge {:ok false
             :status "error"
             :error_type (or (:error-type data) (:error_type data) "runtime_failure")
             :message (or (some-> error .getMessage) "Runtime failure")
             :node_id (name state-id)
             :attempt (get-in ctx [:run :attempt])}
            (when-let [log-file (or (:log_file data) (:log-file data))] {:log_file log-file})
            (when-let [prompt-file (or (:prompt_file data) (:prompt-file data))] {:prompt_file prompt-file})
            (when-let [exit-code (or (:exit_code data) (:exit-code data))] {:exit_code exit-code})
            (when (or data details)
              {:details (json-compatible (merge (dissoc data :log-file :log_file :prompt-file :prompt_file :exit-code :exit_code)
                                                details))})))))

(defn external-error-result? [result]
  (and result
       (or (= false (:ok result))
           (= "error" (:status result)))))

(defn fail-run! [ctx state-id result]
  (let [failed (-> ctx
                   (assoc-in [:run :status] "failed")
                   (assoc-in [:run :updated-at] (store/now)))]
    (store/event! failed {:event "node.failed"
                          :state (name state-id)
                          :attempt (get-in ctx [:run :attempt])
                          :status "error"
                          :error (:message result)
                          :result result})
    (store/save-context! failed)
    failed))

(defn execute-node! [wf ctx state-id node]
  (store/event! ctx {:event "node.started" :state (name state-id) :attempt (get-in ctx [:run :attempt])})
  (try
    (let [result (case (:type node)
                   :agent (let [exec-result (run-agent! wf ctx state-id node)]
                            (when-not (:ok exec-result)
                              (throw (ex-info "Agent executor failed" exec-result)))
                            (merge exec-result (status-result ctx node)))
                   :deterministic (adapters/run-handler! wf ctx state-id node {:mock? (mock-mode? ctx)})
                   :process (run-process-node! wf ctx state-id node)
                   :timer (run-timer-node! wf ctx state-id node)
                   :approval (throw (ex-info "Approval nodes require a control plane" {:state state-id}))
                   :router {:status "ok"}
                   :terminal {:status "ok" :terminal true})]
      (when (external-error-result? result)
        (let [result (normalize-external-result ctx state-id result)]
          (fail-run! ctx state-id result)
          (throw (ex-info (or (:message result) "External node execution failed")
                          (assoc result :tesseraft/already-failed true)))))
      (validate-required-outputs! ctx node)
      (store/event! ctx {:event "node.finished" :state (name state-id) :attempt (get-in ctx [:run :attempt]) :result result})
      result)
    (catch Throwable t
      (when-not (:tesseraft/already-failed (ex-data t))
        (let [result (external-error-result ctx state-id t)]
          (fail-run! ctx state-id result)))
      (throw t))))

(defn recover-completed-agent-node [ctx state-id node]
  (when (= :agent (:type node))
    (let [status-path (artifact-path ctx (spec/status-output-path node))
          required-paths (required-output-paths ctx node)]
      (when (and status-path
                 (fs/exists? status-path)
                 (every? fs/exists? required-paths))
        (let [status (store/read-json status-path)
              result (merge {:executor "pi-cli"
                             :ok true
                             :recovered true
                             :status-file status-path}
                            status)]
          (store/event! ctx {:event "node.recovered"
                             :state (name state-id)
                             :attempt (get-in ctx [:run :attempt])
                             :result result})
          (store/event! ctx {:event "node.finished"
                             :state (name state-id)
                             :attempt (get-in ctx [:run :attempt])
                             :result result})
          result)))))

(defn match-transition? [result transition]
  (let [pred (:when transition)]
    (or (= true (:else pred))
        (every? (fn [[k v]] (= v (get result k))) pred))))

(defn choose-transition [node result]
  (or (some #(when (match-transition? result %) %) (spec/transitions node))
      (throw (ex-info "No transition matched result" {:result result}))))

(defn normalize-issue-path [ctx p]
  (when (and p (not (str/blank? (str p))))
    (if (str/starts-with? (str p) "/") p (str (fs/path (get-in ctx [:run :dir]) p)))))

(defn merge-issues! [ctx result]
  (if-let [issue-file (normalize-issue-path ctx (:issues_file result))]
    (if (fs/exists? issue-file)
      (let [old (if (fs/exists? (get-in ctx [:run :issues-file])) (store/read-json (get-in ctx [:run :issues-file])) [])
            new (store/read-json issue-file)
            keyfn (fn [i] [(:source i) (:title i) (:details i)])
            merged (->> (concat old new) (map #(vector (keyfn %) %)) (into {}) vals vec)]
        (store/write-json! (get-in ctx [:run :issues-file]) merged)
        ctx)
      ctx)
    ctx))

(defn apply-effect [ctx effect result]
  (store/event! ctx {:event "effect.applied" :effect (name effect)})
  (case effect
    :merge-issues (merge-issues! ctx result)
    :clear-issues (do (store/write-json! (get-in ctx [:run :issues-file]) []) ctx)
    :inc-round (update-in ctx [:run :round] inc)
    :inc-feedback-cycle (update-in ctx [:run :feedback-cycle] inc)
    :fail-run (assoc-in ctx [:run :status] "failed")
    :set-context ctx
    :record-pr ctx
    (throw (ex-info "Unknown effect" {:effect effect}))))

(defn apply-effects [ctx effects result]
  (reduce #(apply-effect %1 %2 result) ctx effects))

(defn carry-result-context [ctx result]
  (cond-> ctx
    (:worktree-dir result) (assoc-in [:run :worktree-dir] (:worktree-dir result))
    (:branch result) (assoc-in [:run :branch] (:branch result))))

(defn advance [ctx transition result]
  (-> ctx
      (carry-result-context result)
      (apply-effects (:effects transition []) result)
      (assoc-in [:run :state] (:next transition))
      (update-in [:run :attempt] inc)
      (assoc-in [:run :updated-at] (store/now))))

(defn finish-if-terminal [wf ctx]
  (let [state-id (get-in ctx [:run :state])
        node (spec/node wf state-id)]
    (if (= :terminal (:type node))
      (do
        (store/event! ctx {:event "run.finished" :state (name state-id)})
        (-> ctx
            (assoc-in [:run :status] "done")
            (assoc-in [:run :updated-at] (store/now))))
      ctx)))

(defn read-run-events [ctx]
  (let [p (fs/path (get-in ctx [:run :dir]) "events.jsonl")]
    (when (fs/exists? p)
      (->> (str/split-lines (slurp (str p)))
           (remove str/blank?)
           (keep #(try (json/parse-string % true) (catch Throwable _ nil)))
           vec))))

(defn orphaned-current-attempt? [ctx state-id attempt]
  "True if the events.jsonl shows a node.started for this state+attempt with no
  matching node.finished/node.failed/node.orphaned, which means a prior step
  started this node but never recorded a terminal event (the resume process was
  killed/torn down mid-node). Used in step! to FAIL FAST with node.orphaned
  instead of silently re-running and duplicating node.started."
  (let [events (read-run-events ctx)
        started? (some #(and (= "node.started" (:event %))
                             (= (name state-id) (:state %))
                             (= attempt (:attempt %)))
                       events)
        terminal? (some #(and (#{"node.finished" "node.failed" "node.orphaned"} (:event %))
                               (= (name state-id) (:state %))
                               (= attempt (:attempt %)))
                        events)]
    (and started? (not terminal?))))

(defn orphan-run! [ctx state-id attempt]
  (let [failed (-> ctx
                   (assoc-in [:run :status] "failed")
                   (assoc-in [:run :updated-at] (store/now)))]
    (store/event! failed {:event "node.orphaned"
                          :state (name state-id)
                          :attempt attempt
                          :status "error"
                          :error "Node was started but never reached a terminal event; the run process was likely killed mid-execution."})
    (store/save-context! failed)
    failed))

;; ---- approval (manual input) pause/resume ----
;; An :approval node pauses the run to collect a human decision about a produced
;; artifact. On first entry it writes a run-relative approval-request record,
;; appends approval.requested, marks the run "blocked", and parks (no
;; node.started/finished are emitted, so orphan detection is not triggered). On
;; resume (after a decision record is written by decide!), it appends
;; approval.decided and advances through the transition whose :when matches
;; {:decision "..."}. See design §3 R1.

(defn approval-request-path [ctx state-id attempt]
  (fs/path (get-in ctx [:run :dir]) "approvals" (str (name state-id) "-" attempt ".json")))

(defn approval-decision-path [ctx state-id attempt]
  (fs/path (get-in ctx [:run :dir]) "approvals" (str (name state-id) "-" attempt "-decision.json")))

(defn load-approval-decision [ctx state-id attempt]
  (let [p (approval-decision-path ctx state-id attempt)]
    (when (fs/exists? p) (store/read-json p))))

(defn render-artifact [ctx node]
  (when-let [art (:artifact node)]
    (cond-> art
      (string? (:path art))
      (assoc :path (spec/render-template-string (:path art) ctx)))))

;; ---- approval presentation contract ----
;; The Web UI should render the decision screen from the durable request
;; record rather than hard-coded labels, so phase-2 reviewer routing becomes
;; a routing change instead of a redesign. When the node author supplies an
;; explicit `:presentation` block, it is materialized verbatim (with
;; template-rendered artifact paths). When absent, we synthesize a minimal
;; presentation from the legacy `:message` + single `:artifact` form and the
;; node's `:transitions` whose `:when` carries a `:decision`. `routing`
;; defaults to `{:kind :self}`. The posted `decision` string still matches
;; transition `:when {:decision "..."}` unchanged.
(defn approval-presentation [ctx node]
  (if-let [pres (:presentation node)]
    (-> pres
        (update :question #(some-> % str))
        (update :artifacts
                (fn [arts]
                  (mapv (fn [a]
                          (cond-> a
                            (and (map? a) (string? (:path a)))
                            (assoc :path (spec/render-template-string (:path a) ctx))))
                        arts)))
        (update :routing #(or % {:kind :self})))
    ;; Synthesize from the legacy form.
    (let [artifact (render-artifact ctx node)
          decisions (->> (spec/transitions node)
                         (keep (fn [tr]
                                 (when-let [d (get-in tr [:when :decision])]
                                   {:decision (str d)
                                    :label (str d)
                                    :next (some-> (:next tr) name)}))))]
      {:question (some-> (:message node) str)
       :artifacts (if artifact [artifact] [])
       :decisions decisions
       :routing {:kind :self}})))

(defn step-approval! [wf ctx state-id attempt node]
  (if-let [decision (load-approval-decision ctx state-id attempt)]
    ;; Resume: a decision record exists. Build a result carrying :decision so
    ;; the node's :transitions :when {:decision "..."} can match, then advance.
    (let [result {:status "ok" :ok true
                  :approval_id (:approval_id decision)
                  :decision (:decision decision)}
          ; match-transition? compares :when predicates against result keys.
          tr (or (some #(when (match-transition? result %) %) (spec/transitions node))
                 (throw (ex-info "No approval transition matched the recorded decision"
                                 {:state state-id :decision (:decision decision)})))
          ctx (store/event! ctx {:event "approval.decided"
                                  :state (name state-id)
                                  :attempt attempt
                                  :approval_id (:approval_id decision)
                                  :decision (:decision decision)})
          ctx (store/event! ctx {:event "transition.selected"
                                  :from (name state-id)
                                  :to (name (:next tr))
                                  :effects (mapv name (:effects tr []))})
          advanced (finish-if-terminal wf (advance ctx tr result))]
      (store/save-context! advanced))
    ;; Pause: no decision yet. Write the approval-request record (idempotent),
    ;; append approval.requested only on first creation, mark the run blocked,
    ;; and park. Returning a blocked ctx makes run-until-done! stop cleanly.
    (let [req-path (approval-request-path ctx state-id attempt)
          already? (fs/exists? req-path)
          artifact (render-artifact ctx node)
          presentation (approval-presentation ctx node)
          approval-id (str (name state-id) "-" attempt)
          request {:approval_id approval-id
                   :run_id (get-in ctx [:run :id])
                   :state (name state-id)
                   :attempt attempt
                   :message (:message node)
                   :artifact artifact
                   ;; Presentation contract (P0.2 review). The UI renders the
                   ;; decision screen from these fields; legacy `message` /
                   ;; `artifact` are kept for backward compatibility. When the
                   ;; node authored a `:presentation`, it is materialized
                   ;; verbatim; otherwise a minimal one is synthesized from
                   ;; `:message` + `:artifact` + decision transitions.
                   :question (:question presentation)
                   :artifacts (:artifacts presentation)
                   :decisions (:decisions presentation)
                   :routing (:routing presentation)
                   :requested_at (store/now)
                   :status "pending"}
          ctx (if already?
                ctx
                (do (fs/create-dirs (fs/parent req-path))
                    (store/write-json! req-path request)
                    (store/event! ctx {:event "approval.requested"
                                       :state (name state-id)
                                       :attempt attempt
                                       :approval_id approval-id
                                       :artifact (and artifact (:path artifact))})))
          ctx (-> ctx
                  (assoc-in [:run :status] "blocked")
                  (assoc-in [:run :updated-at] (store/now)))]
      (store/save-context! ctx))))

(defn step! [wf ctx]
  (if (= "done" (get-in ctx [:run :status]))
    ctx
    (let [state-id (get-in ctx [:run :state])
          attempt (get-in ctx [:run :attempt])
          node (spec/node wf state-id)]
      (when-not node (throw (ex-info "Current state not found" {:state state-id})))
      (cond
        (= :terminal (:type node))
        (finish-if-terminal wf ctx)

        (= :approval (:type node))
        (step-approval! wf ctx state-id attempt node)

        :else
        ;; Recovery (existing path) handles a completed agent node whose status
        ;; artifact exists. If recovery returns nil, check for an orphan: a
        ;; prior node.started with no terminal event means the resume process
        ;; was killed mid-node. Fail fast with node.orphaned instead of
        ;; silently re-running and duplicating node.started.
        (if-let [recovered (recover-completed-agent-node ctx state-id node)]
          (let [tr (choose-transition node recovered)]
            (store/event! ctx {:event "transition.selected" :from (name state-id) :to (name (:next tr)) :effects (mapv name (:effects tr []))})
            (finish-if-terminal wf (advance ctx tr recovered)))
          (if (orphaned-current-attempt? ctx state-id attempt)
            (let [failed (orphan-run! ctx state-id attempt)]
              (throw (ex-info "Orphaned node detected: started without a terminal event"
                              {:state state-id :attempt attempt :tesseraft/already-failed true})))
            (let [result (execute-node! wf ctx state-id node)
                  tr (choose-transition node result)]
              (store/event! ctx {:event "transition.selected" :from (name state-id) :to (name (:next tr)) :effects (mapv name (:effects tr []))})
              (finish-if-terminal wf (advance ctx tr result)))))))))

(defn read-project-git-user []
  (let [p (fs/path ".tesseraft" "git-user.json")]
    (when (fs/exists? p) (store/read-json p))))

;; decide!: record a human decision for the pending approval at the run's
;; current state+attempt, then advance the run through the matching transition.
;; Returns either {:run <advanced-run-map>} on success or a structured error
;; {:status N :error {:code ... :message ...}} on a recoverable failure, so the
;; caller can print JSON and map status to HTTP codes without a try/catch.
;; Idempotent: a second decide on an already-decided approval returns 409
;; conflict. This is the load-bearing mutation behind POST /approvals/{id}.
(defn decide!
  ([run-dir approval-id decision]
   (decide! run-dir approval-id decision nil nil))
  ([run-dir approval-id decision summary author-overrides]
   (let [ctx (store/load-context run-dir)
         wf-file (get-in ctx [:workflow :file])
         wf (spec/read-workflow wf-file)
         state-id (get-in ctx [:run :state])
         attempt (get-in ctx [:run :attempt])
         node (spec/node wf state-id)
         expected-id (str (name state-id) "-" attempt)]
     (cond
       (or (nil? node) (not= :approval (:type node)))
       {:status 422 :error {:code "not_approval"
                            :message (str "Current state " state-id " is not an approval node")}}

       (not= expected-id approval-id)
       {:status 409 :error {:code "stale_approval"
                            :message (str "Approval id " approval-id
                                          " does not match the current pending approval " expected-id)
                            :details {:expected expected-id :provided approval-id}}}

       (fs/exists? (approval-decision-path ctx state-id attempt))
       {:status 409 :error {:code "conflict"
                            :message "A decision has already been recorded for this approval"}}

       :else
       (let [author (or (when (and (map? author-overrides)
                                   (seq (str (:name author-overrides)))
                                   (seq (str (:email author-overrides))))
                         {:name (str (:name author-overrides))
                          :email (str (:email author-overrides))})
                       (read-project-git-user)
                       {:name "unknown" :email "unknown@tesseraft.local"})
             decision-rec {:approval_id approval-id
                           :run_id (get-in ctx [:run :id])
                           :state (name state-id)
                           :attempt attempt
                           :decision decision
                           :summary summary
                           :author author
                           :decided_at (store/now)}
             dec-path (approval-decision-path ctx state-id attempt)]
         (fs/create-dirs (fs/parent dec-path))
         (store/write-json! dec-path decision-rec)
         ;; step! now sees the decision record and advances the run.
         {:run (:run (step! wf ctx))})))))

(defn assert-lint-ok! [workflow-file]
  (let [result (lint/lint-file workflow-file)]
    (when-not (:ok result)
      (throw (ex-info "Workflow lint failed" result)))))

(defn start! [workflow-file opts]
  (assert-lint-ok! workflow-file)
  (let [wf (spec/read-workflow workflow-file)
        ctx (-> (init-context wf opts) store/ensure-run-dirs! store/save-context!)]
    (store/event! ctx {:event "run.started"})
    ctx))

(defn run-until-done! [wf ctx max-steps]
  (loop [ctx (store/save-context! (store/ensure-run-dirs! ctx)) n 0]
    ;; Hard invariant guard: never exceed the step budget. This should never
    ;; fire in normal operation because the pre-check below stops the loop
    ;; before starting a node the budget cannot let finish.
    (when (> n max-steps) (throw (ex-info "Exceeded max steps" {:max-steps max-steps})))
    (let [status (get-in ctx [:run :status])]
      (cond
        ;; A run is "blocked" when it parked at an :approval node awaiting a
        ;; human decision. Stop advancing; the run is resumed by decide!
        ;; (which writes a decision record and calls step!), not by looping.
        (#{"done" "blocked"} status) ctx
        ;; Pre-check: stop cleanly (park) before starting a node we cannot let
        ;; finish. max-steps is the number of steps we are allowed to start.
        ;; n is the number of steps already started. If (= n max-steps) the
        ;; budget is exhausted, so park instead of advancing. This prevents a
        ;; bounded `resume --max-steps N` from starting a node and then being
        ;; torn down mid-flight, which would orphan an in-flight node.
        (>= n max-steps) ctx
        :else (recur (store/save-context! (step! wf ctx)) (inc n))))))
