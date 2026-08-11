(ns tesseraft.runtime.liveness
  (:require [tesseraft.runtime.fragment :as fragment]
            [tesseraft.runtime.lifecycle :as lifecycle]
            [tesseraft.runtime.store :as store]))

(def read-run-events lifecycle/read-run-events)

(defn heartbeat-interval-ms []
  (or (some-> (System/getenv "TESSERAFT_HEARTBEAT_INTERVAL_MS")
              parse-long
              (#(when (and % (pos? %)) %)))
      30000))

(defn execute-with-heartbeat [ctx state-id attempt f]
  (let [active? (atom true)
        interval (heartbeat-interval-ms)
        worker (future
                 (try
                   (while @active?
                     (Thread/sleep interval)
                     (when @active?
                       (store/event! ctx {:event "node.heartbeat"
                                          :state (name state-id)
                                          :attempt attempt})))
                   (catch InterruptedException _ nil)))]
    (try
      (f)
      (finally
        (reset! active? false)
        (future-cancel worker)
        (try
          (deref worker 1000 nil)
          (catch java.util.concurrent.CancellationException _ nil))))))

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

(defn resumable-fragment?
  "True when the current node is a :fragment whose durable nested run already
  exists: a prior process's parent-level node.started for this state+attempt
  is not an orphan in that case, it is a fragment step continuing from its
  own persisted boundary (run-fragment-node! decides terminal-vs-continuing)."
  [ctx state-id attempt node]
  (and (= :fragment (:type node))
       (fragment/durable-internal-run? ctx state-id attempt)))

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
