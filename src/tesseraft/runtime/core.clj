(ns tesseraft.runtime.core
  (:require
    [tesseraft.adapters.builtin :as adapters]
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
        inputs (if (:branch inputs) inputs (assoc inputs :branch (default-branch inputs)))]
    {:workflow {:name name
                :file (spec/workflow-file wf)
                :version (str "sha256:" (store/sha256 content))
                :defaults (:defaults wf {})}
     :inputs inputs
     :run {:id run-id
           :dir run-dir
           :state (:initial wf)
           :status "running"
           :round 1
           :attempt 1
           :feedback-cycle 1
           :issues-file (str (fs/path run-dir "issues.json"))
           :created-at (store/now)
           :updated-at (store/now)}}))

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
                   :agent (let [exec-result (pi-cli/run-agent-node! wf ctx state-id node)]
                            (when-not (:ok exec-result)
                              (throw (ex-info "Agent executor failed" exec-result)))
                            (merge exec-result (status-result ctx node)))
                   :deterministic (adapters/run-handler! wf ctx state-id node)
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

(defn step! [wf ctx]
  (if (= "done" (get-in ctx [:run :status]))
    ctx
    (let [state-id (get-in ctx [:run :state])
          node (spec/node wf state-id)]
      (when-not node (throw (ex-info "Current state not found" {:state state-id})))
      (if (= :terminal (:type node))
        (finish-if-terminal wf ctx)
        (let [result (execute-node! wf ctx state-id node)
              tr (choose-transition node result)]
          (store/event! ctx {:event "transition.selected" :from (name state-id) :to (name (:next tr)) :effects (mapv name (:effects tr []))})
          (finish-if-terminal wf (advance ctx tr result)))))))

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
    (when (> n max-steps) (throw (ex-info "Exceeded max steps" {:max-steps max-steps})))
    (if (= "done" (get-in ctx [:run :status]))
      ctx
      (recur (store/save-context! (step! wf ctx)) (inc n)))))
