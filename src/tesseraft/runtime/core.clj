(ns tesseraft.runtime.core
  (:require
    [tesseraft.adapters.builtin :as adapters]
    [tesseraft.executors.mock :as mock]
    [tesseraft.capabilities.executors :as executor-catalog]
    [tesseraft.lint.core :as lint]
    [tesseraft.spec :as spec]
    [tesseraft.runtime.approvals :as approvals]
    [tesseraft.runtime.fragment :as fragment]
    [tesseraft.runtime.lifecycle :as lifecycle]
    [tesseraft.runtime.liveness :as liveness]
    [tesseraft.runtime.store :as store]
    [tesseraft.runtime.transitions :as transitions]
    [babashka.fs :as fs]
    [babashka.process :as p]
    [cheshire.core :as json]
    [clojure.string :as str]))

;; run-until-done! is defined near the bottom of this file (after step!) but
;; run-fragment-node! needs to run the nested internal loop to completion as
;; part of a single parent step, so forward-declare it here.
(declare run-until-done!)

(def parse-input lifecycle/parse-input)
(def terminal-run-statuses lifecycle/terminal-run-statuses)
(def terminal-run? lifecycle/terminal-run?)
(def runtime-process-path lifecycle/runtime-process-path)
(def register-runtime-process! lifecycle/register-runtime-process!)
(def unregister-runtime-process! lifecycle/unregister-runtime-process!)
(def run-owner-env lifecycle/run-owner-env)
(def run-tracked-process! lifecycle/run-tracked-process!)
(def stop-owned-processes! lifecycle/stop-owned-processes!)
(def stop-runtime-process! lifecycle/stop-runtime-process!)
(def retry-allowed-status? lifecycle/retry-allowed-status?)
(def read-run-events lifecycle/read-run-events)
(def last-terminal-evidence lifecycle/last-terminal-evidence)
(def retry! lifecycle/retry!)
(def cancel! lifecycle/cancel!)
(def default-branch lifecycle/default-branch)
(def init-context lifecycle/init-context)
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
        result (run-tracked-process! (get-in ctx [:run :dir]) (mapv str cmd)
                                     {:dir (spec/workflow-dir wf)
                                      :in (json/generate-string request)
                                      :out :string :err :string :continue true
                                      :extra-env (run-owner-env ctx)})
        log-file (str (fs/path (get-in ctx [:run :dir]) "logs" (str (name state-id) "-process-" (get-in ctx [:run :attempt]) ".log")))]
    (store/write-runtime-text! ctx log-file (str "COMMAND: " (str/join " " cmd) "\n\nSTDOUT:\n" (:out result) "\n\nSTDERR:\n" (:err result) "\n"))
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
  (cond
    (mock-mode? ctx)        (mock/run-agent-node! wf ctx state-id node)
    :else (executor-catalog/invoke! (:executor node) wf ctx state-id node)))

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

(defn derived-fragment-step-budget
  "A defensive step budget for the nested internal loop, generous relative to
  the fragment's own effective max-rounds so well-formed fragments always
  finish (via a terminal or their own max-rounds failure) well within it."
  [internal-wf]
  (let [max-rounds (get-in internal-wf [:defaults :max-rounds])
        state-count (max 1 (count (:states internal-wf)))]
    (max 200 (* 20 state-count (or max-rounds 10)))))

(defn- run-internal-until-done!
  "Run the nested internal loop to completion (or until it parks/fails),
  reloading and returning the durably-recorded terminal internal ctx instead
  of losing the classified cause when run-until-done! itself throws.
  execute-node! usually already durably recorded the nested failure via
  fail-run!/fail-max-rounds!/orphan-run! before rethrowing, marking nested
  state.edn \"failed\"/\"done\". But choose-transition can also throw from
  step! *outside* execute-node!'s own try/catch (e.g. no transition matches
  the result) — nothing durably records that, so the reloaded state still
  reads \"running\". Reloading it there would mask the real cause behind a
  generic step-budget message, so rethrow the original throwable whenever the
  persisted nested state is absent or was never brought to a terminal status."
  [internal-wf internal-ctx budget]
  (let [internal-dir (get-in internal-ctx [:run :dir])]
    (try
      (run-until-done! internal-wf internal-ctx budget)
      (catch Throwable t
        (let [reloaded (when (fs/exists? (fs/path internal-dir "state.edn"))
                         (store/load-context internal-dir))]
          (if (contains? #{"failed" "done"} (get-in reloaded [:run :status]))
            reloaded
            (throw t)))))))

(defn run-fragment-node! [wf ctx state-id node]
  (let [attempt (get-in ctx [:run :attempt])
        {:keys [inclusion pkg]} (fragment/resolve-inclusion! wf ctx state-id node)]
    (fragment/assert-supported-internal-nodes! state-id pkg)
    (let [internal-wf (fragment/internal-workflow pkg inclusion)]
      (if (fragment/durable-internal-run? ctx state-id attempt)
        ;; A prior process already created (and possibly progressed, or even
        ;; fully finished) this internal run: continue from its persisted
        ;; boundary rather than recreating it, so no completed internal effect
        ;; is ever replayed.
        (let [reloaded (fragment/resume-internal-context ctx state-id attempt pkg)]
          ;; Every durable branch continues (or maps the outcome of) a nested
          ;; run that was pinned against a specific package content hash;
          ;; verify it before finish! reads pkg/inclusion for the terminal
          ;; branch too, so a package edited after the nested run reached its
          ;; own terminal status is never used to map its outcome or
          ;; materialize its exit outputs.
          (fragment/verify-pin! state-id pkg inclusion reloaded)
          (if (fragment/terminal-internal-run? reloaded)
            (fragment/finish! ctx state-id attempt node pkg inclusion internal-wf reloaded)
            (do
              (fragment/resumed! ctx state-id attempt pkg reloaded)
              (let [budget (derived-fragment-step-budget internal-wf)
                    internal-ctx (run-internal-until-done! internal-wf reloaded budget)]
                (fragment/finish! ctx state-id attempt node pkg inclusion internal-wf internal-ctx)))))
        (let [internal-ctx0 (fragment/internal-context ctx state-id attempt pkg internal-wf inclusion)]
          (fragment/pin! ctx state-id attempt pkg inclusion internal-ctx0)
          (let [budget (derived-fragment-step-budget internal-wf)
                internal-ctx (run-internal-until-done! internal-wf internal-ctx0 budget)]
            (fragment/finish! ctx state-id attempt node pkg inclusion internal-wf internal-ctx)))))))

(defn execute-node! [wf ctx state-id node]
  (store/event! ctx {:event "node.started" :state (name state-id) :attempt (get-in ctx [:run :attempt])})
  (try
    (let [result (case (:type node)
                   :agent (let [exec-result (run-agent! wf ctx state-id node)]
                            (when-not (:ok exec-result)
                              (throw (ex-info "Agent executor failed" exec-result)))
                            (merge exec-result (status-result ctx node)))
                   :deterministic (binding [adapters/*process-extra-env* (run-owner-env ctx)]
                                    (adapters/run-handler! wf ctx state-id node {:mock? (mock-mode? ctx)}))
                   :process (run-process-node! wf ctx state-id node)
                   :timer (run-timer-node! wf ctx state-id node)
                   :approval (throw (ex-info "Approval nodes require a control plane" {:state state-id}))
                   :router {:status "ok"}
                   :terminal {:status "ok" :terminal true}
                   :fragment (run-fragment-node! wf ctx state-id node))]
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
              executor-name (or (some-> (:executor node) name) "unknown")
              result (merge {:executor executor-name
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

(def choose-transition transitions/choose-transition)
(def normalize-issue-path transitions/normalize-issue-path)
(def merge-issues! transitions/merge-issues!)
(def apply-effect transitions/apply-effect)
(def apply-effects transitions/apply-effects)
(def carry-result-context transitions/carry-result-context)
(def advance transitions/advance)
(def finish-if-terminal transitions/finish-if-terminal)
(def max-rounds-exceeded? transitions/max-rounds-exceeded?)
(def fail-max-rounds! transitions/fail-max-rounds!)
(def heartbeat-interval-ms liveness/heartbeat-interval-ms)
(def execute-with-heartbeat liveness/execute-with-heartbeat)
(def orphaned-current-attempt? liveness/orphaned-current-attempt?)
(def resumable-fragment? liveness/resumable-fragment?)
(def orphan-run! liveness/orphan-run!)
(def approval-request-path approvals/approval-request-path)
(def approval-decision-path approvals/approval-decision-path)
(def load-approval-decision approvals/load-approval-decision)
(def render-artifact approvals/render-artifact)
(def approval-presentation approvals/approval-presentation)
(def step-approval! approvals/step-approval!)
(defn step! [wf ctx]
  (if (terminal-run? ctx)
    ctx
    (let [state-id (get-in ctx [:run :state])
          attempt (get-in ctx [:run :attempt])
          node (spec/node wf state-id)]
      (when-not node (throw (ex-info "Current state not found" {:state state-id})))
      (cond
        (max-rounds-exceeded? wf ctx)
        (fail-max-rounds! wf ctx)

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
          (if (and (orphaned-current-attempt? ctx state-id attempt)
                   (not (resumable-fragment? ctx state-id attempt node)))
            (let [failed (orphan-run! ctx state-id attempt)]
              (throw (ex-info "Orphaned node detected: started without a terminal event"
                              {:state state-id :attempt attempt :tesseraft/already-failed true})))
            (let [result (execute-with-heartbeat
                           ctx state-id attempt
                           #(execute-node! wf ctx state-id node))
                  tr (choose-transition node result)]
              (store/event! ctx {:event "transition.selected" :from (name state-id) :to (name (:next tr)) :effects (mapv name (:effects tr []))})
              (finish-if-terminal wf (advance ctx tr result)))))))))

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
                       (get-in ctx [:run :git-user])
                       {:name "unknown" :email "unknown@tesseraft.local"})
             decision-rec {:version 1
                           :approval_id approval-id
                           :run_id (get-in ctx [:run :id])
                           :state (name state-id)
                           :attempt attempt
                           :decision decision
                           :summary summary
                           :author author
                           :decided_at (store/now)}
             dec-path (approval-decision-path ctx state-id attempt)]
         (store/write-runtime-json! ctx dec-path decision-rec)
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
    (store/event! ctx {:event "project.resolved"
                       :project_id (get-in ctx [:run :project-id])})
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
        (or (contains? terminal-run-statuses status) (= "blocked" status)) ctx
        ;; Pre-check: stop cleanly (park) before starting a node we cannot let
        ;; finish. max-steps is the number of steps we are allowed to start.
        ;; n is the number of steps already started. If (= n max-steps) the
        ;; budget is exhausted, so park instead of advancing. This prevents a
        ;; bounded `resume --max-steps N` from starting a node and then being
        ;; torn down mid-flight, which would orphan an in-flight node.
        (>= n max-steps) ctx
        :else (recur (store/save-context! (step! wf ctx)) (inc n))))))
