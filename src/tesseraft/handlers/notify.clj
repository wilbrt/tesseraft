(ns tesseraft.handlers.notify
  (:require
    [babashka.fs :as fs]
    [tesseraft.executors.process :as process]))

(defn availability []
  (let [configured (System/getenv "PINGA_BIN")]
    (cond
      (and configured (fs/exists? configured) (fs/executable? configured))
      {:status "ready" :executable configured}
      configured {:status "unavailable" :reason "PINGA_BIN is not executable"}
      :else {:status "unavailable" :reason "PINGA_BIN is not configured"})))

(defn notify-pinga! [_wf ctx _state-id _node]
  (let [message (str "Workflow finished: " (or (get-in ctx [:workflow :name])
                                                (get-in ctx [:workflow :metadata :name])
                                                "workflow")
                     "\nRun dir: " (get-in ctx [:run :dir]) "\n")
        executable (System/getenv "PINGA_BIN")]
    (if-not executable
      {:ok false :status "error" :category "configuration" :code "pinga_unavailable"
       :message "PINGA_BIN is not configured"}
      (let [result (process/run! {:cmd [executable message] :dir "." :env {}})]
        (merge result {:handler "notify/pinga"})))))

(defn mock-notify-pinga! [_wf _ctx _state-id _node]
  {:ok true :status "ok" :mock true :handler "notify/pinga"})
