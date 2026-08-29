(ns tesseraft.runtime.operations
  (:require
    [babashka.fs :as fs]
    [tesseraft.runtime.approval-server :as approval-server]
    [tesseraft.runtime.core :as runtime]
    [tesseraft.runtime.identity :as identity]
    [tesseraft.runtime.process :as runtime-process]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]))

(defn- error [status code message]
  {:status status :error {:code code :message message :details {}}})

(def execution-operations #{"run.step" "run.resume"})

(defn- real-path [value]
  (try
    (str (.toRealPath (java.nio.file.Paths/get value (make-array String 0))
                      (make-array java.nio.file.LinkOption 0)))
    (catch Throwable _ nil)))

(defn- adapter-fence-error [operation payload]
  (when (= "true" (System/getenv "TESSERAFT_ADAPTER_INTERNAL"))
    (let [bound-run (System/getenv "AGENT_RUN_DIR")
          bound-approval (System/getenv "TESSERAFT_ADAPTER_APPROVAL_ID")
          bound-real (real-path bound-run)
          payload-real (real-path (:run_dir payload))]
      (cond
        (not (contains? #{"run.decide" "approval.adapter.supervise" "approval.adapter.status"} operation))
        (error 403 "adapter_operation_forbidden" "Focused adapter operation is not permitted")

        (or (nil? bound-real) (nil? payload-real) (not= bound-real payload-real))
        (error 403 "adapter_run_mismatch" "Focused adapter run does not match its process binding")

        (or (nil? bound-approval) (not= bound-approval (:approval_id payload)))
        (error 403 "adapter_approval_mismatch" "Focused adapter approval does not match its process binding")))))

(defn execute-claimed-operation
  "Execute an operation only after bootstrap-intent! published this child's
  exact state-authoritative claim. Never call from a launcher or HTTP process."
  [request]
  (let [operation (:operation request)
        payload (or (:payload request) {})
        run-dir (:run_dir payload)]
    (if-not (and (contains? execution-operations operation)
                 (string? run-dir) (not-empty run-dir))
      (error 400 "bad_request" "claimed execution requires run.step/run.resume and payload.run_dir")
      (case operation
        "run.step"
        (let [ctx (cond-> (store/load-context run-dir)
                    (:executor payload) (assoc-in [:run :executor-mode] (:executor payload)))
              wf (spec/read-workflow (get-in ctx [:workflow :file]))
              advanced (store/save-context! (runtime/step! wf ctx))]
          {:ok true :operation operation :result {:run (:run advanced)}})

        "run.resume"
        (let [max-steps (or (:max_steps payload) 100)]
          (if-not (and (integer? max-steps) (<= 1 max-steps 1000))
            (error 400 "bad_request" "max_steps must be an integer from 1 to 1000")
            (let [ctx (cond-> (store/load-context run-dir)
                        (:executor payload) (assoc-in [:run :executor-mode] (:executor payload)))
                  wf (spec/read-workflow (get-in ctx [:workflow :file]))]
              {:ok true :operation operation
               :result {:run (:run (runtime/run-until-done! wf ctx max-steps))}})))))))

(defn apply-operation [request]
  (let [operation (:operation request)
        payload (or (:payload request) {})
        run-dir (:run_dir payload)
        fence-error (adapter-fence-error operation payload)]
    (cond
      fence-error fence-error
      (not (and (string? run-dir) (not-empty run-dir)))
      (error 400 "bad_request" "payload.run_dir is required")
      :else
      (if (contains? execution-operations operation)
        (runtime-process/launch-intent! run-dir operation
                                        (select-keys payload [:max_steps :executor]))
        (case operation
          "run.cancel" (let [ctx (runtime/cancel! run-dir)]
                         {:ok true :operation operation :result {:run (:run ctx)}})
          "approval.adapter.supervise"
          (let [supervised (approval-server/supervise-drain! payload)
                resumed (when (= :resume-requested (:handoff supervised))
                          (runtime-process/launch-intent! run-dir "run.resume" {}))]
            {:ok true :operation operation
             :result (cond-> supervised resumed (assoc :resume resumed))})
          "approval.adapter.reconcile"
          (let [reconciled (approval-server/reconcile-drains! run-dir)
                resumed (some #(when (= :resume-requested (:handoff %))
                                 (runtime-process/launch-intent! run-dir "run.resume" {}))
                              reconciled)]
            {:ok true :operation operation
             :result {:reconciled reconciled :resume resumed}})
          "approval.adapter.status"
          (let [ctx (store/load-context run-dir)
                state-id (get-in ctx [:run :state])
                attempt (get-in ctx [:run :attempt])
                approval-id (identity/approval-id state-id attempt)
                decision-exists? (fs/exists? (runtime/approval-decision-path ctx state-id attempt))
                authority (approval-server/validate-focused-request ctx approval-id)
                pending? (and (= "blocked" (get-in ctx [:run :status]))
                              (not decision-exists?) (:valid authority))]
            {:ok true :operation operation
             :result {:run_id (get-in ctx [:run :id])
                      :state (identity/state-string state-id)
                      :attempt attempt
                      :status (get-in ctx [:run :status])
                      :approval_id approval-id
                      :decision_exists decision-exists?
                      :authority_valid (boolean (:valid authority))
                      :pending (boolean pending?)}})
          "run.decide" (let [result (runtime/decide! run-dir (:approval_id payload) (:decision payload)
                                                      (or (:message payload) (:summary payload))
                                                      (:annotations payload) (:author payload))]
                         (if (:error result) result {:ok true :operation operation :result result}))
          (error 400 "unknown_operation" (str "Unknown runtime operation: " operation)))))))
