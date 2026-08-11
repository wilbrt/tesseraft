(ns tesseraft.work-tracker.retry)

(defn retryable? [response]
  (let [status (or (:status response) (get response "status"))]
    (or (contains? #{:timeout :transport} (or (:error response) (get response "error")))
        (and (integer? status) (<= 500 status 599)))))

(defn request
  "Invoke `request-fn` with bounded attempts. Sleeping is injected so tests and
  default local runs remain deterministic; callers opt into delays explicitly."
  [request-fn request {:keys [max-attempts sleep-fn delay-ms]
                       :or {max-attempts 2 sleep-fn (fn [_]) delay-ms 0}}]
  (loop [attempt 1]
    (let [response (request-fn request)]
      (if (and (< attempt max-attempts) (retryable? response))
        (do (sleep-fn delay-ms) (recur (inc attempt)))
        (assoc response :attempts attempt)))))
