(ns tesseraft.executors.process
  (:require [babashka.process :as process]
            [tesseraft.runtime.process :as runtime-process]))

(def ^:dynamic *runner* nil)

(defn production-runner [{:keys [cmd dir input env]}]
  (let [opts {:dir dir :in input :out :string :err :string :continue true :extra-env env}
        run-dir (get env "AGENT_RUN_DIR")
        result (if run-dir
                 (runtime-process/run-tracked! run-dir cmd opts)
                 (deref (process/process cmd opts)))]
    {:exit-code (:exit result) :stdout (str (:out result)) :stderr (str (:err result))}))

(defn run! [request]
  (try
    (let [result ((or *runner* production-runner) request)
          exit-code (:exit-code result)]
      (if (and (integer? exit-code) (zero? exit-code))
        (assoc result :ok true :status "ok" :category nil :code nil :message nil)
        (assoc result :ok false :status "error" :category "process"
                      :code "executor_process_failed"
                      :message "Executor process exited unsuccessfully")))
    (catch Throwable t
      {:ok false :status "error" :category "process" :code "executor_process_failed"
       :message "Executor process could not be started" :exit-code nil
       :stdout "" :stderr "" :details {:exception_class (.getName (class t))}})))
