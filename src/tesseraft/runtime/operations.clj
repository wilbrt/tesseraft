(ns tesseraft.runtime.operations
  (:require
    [tesseraft.runtime.approval-server :as approval-server]
    [tesseraft.runtime.core :as runtime]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]))

(defn- error [status code message]
  {:status status :error {:code code :message message :details {}}})

(defn- with-runtime-claim [run-dir f]
  (let [pid (runtime/register-runtime-process! run-dir)]
    (try (f) (finally (runtime/unregister-runtime-process! run-dir pid)))))

(defn apply-operation [request]
  (let [operation (:operation request)
        payload (or (:payload request) {})
        run-dir (:run_dir payload)]
    (if-not (and (string? run-dir) (not-empty run-dir))
      (error 400 "bad_request" "payload.run_dir is required")
      (case operation
        "run.step" (with-runtime-claim run-dir
                     (fn []
                       (let [ctx (store/load-context run-dir)
                             wf (spec/read-workflow (get-in ctx [:workflow :file]))
                             advanced (store/save-context! (runtime/step! wf ctx))]
                         {:ok true :operation operation :result {:run (:run advanced)}})))
        "run.resume" (let [max-steps (or (:max_steps payload) 100)]
                       (if-not (and (integer? max-steps) (<= 1 max-steps 1000))
                         (error 400 "bad_request" "max_steps must be an integer from 1 to 1000")
                         (with-runtime-claim run-dir
                           (fn []
                             (let [ctx (store/load-context run-dir)
                                   wf (spec/read-workflow (get-in ctx [:workflow :file]))]
                               {:ok true :operation operation :result {:run (:run (runtime/run-until-done! wf ctx max-steps))}})))))
        "run.cancel" (let [ctx (runtime/cancel! run-dir)]
                       {:ok true :operation operation :result {:run (:run ctx)}})
        "approval.adapter.supervise"
        (let [supervised (approval-server/supervise-drain! payload)]
          ;; A committed destination is a durable resume request only. The
          ;; detached cleanup worker must not step it until the shared
          ;; generation/child-claim launcher consumes that handoff.
          {:ok true :operation operation :result supervised})
        "run.decide" (let [result (runtime/decide! run-dir (:approval_id payload) (:decision payload)
                                                    (or (:message payload) (:summary payload))
                                                    (:annotations payload) (:author payload))]
                       (if (:error result) result {:ok true :operation operation :result result}))
        (error 400 "unknown_operation" (str "Unknown runtime operation: " operation))))))
