(ns tesseraft.runtime.operations
  (:require
    [tesseraft.runtime.approval-server :as approval-server]
    [tesseraft.runtime.core :as runtime]
    [tesseraft.runtime.process :as runtime-process]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]))

(defn- error [status code message]
  {:status status :error {:code code :message message :details {}}})

(def execution-operations #{"run.step" "run.resume"})

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
        run-dir (:run_dir payload)]
    (if-not (and (string? run-dir) (not-empty run-dir))
      (error 400 "bad_request" "payload.run_dir is required")
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
          "run.decide" (let [result (runtime/decide! run-dir (:approval_id payload) (:decision payload)
                                                      (or (:message payload) (:summary payload))
                                                      (:annotations payload) (:author payload))]
                         (if (:error result) result {:ok true :operation operation :result result}))
          (error 400 "unknown_operation" (str "Unknown runtime operation: " operation)))))))
