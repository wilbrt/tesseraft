(ns tesseraft.runtime.core-test
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.string :as str]
    [clojure.test :refer [deftest is testing]]
    [tesseraft.runtime.core :as runtime]
    [tesseraft.runtime.liveness :as liveness]
    [tesseraft.runtime.operations :as operations]
    [tesseraft.runtime.store :as store]))

(defn- temp-dir [prefix]
  (str (java.nio.file.Files/createTempDirectory
         prefix
         (make-array java.nio.file.attribute.FileAttribute 0))))

(defn- read-events [dir]
  (mapv #(json/parse-string % true)
        (remove str/blank? (str/split-lines (slurp (str dir "/events.jsonl"))))))

(deftest execute-with-heartbeat-persists-in-flight-events
  (let [dir (temp-dir "tesseraft-heartbeat")
        ctx {:run {:dir dir}}]
    (try
      (with-redefs [liveness/heartbeat-interval-ms (constantly 20)]
        (is (= :ok (runtime/execute-with-heartbeat ctx :slow-node 7
                     #(do (Thread/sleep 110) :ok)))))
      (let [heartbeats (filter #(= "node.heartbeat" (:event %)) (read-events dir))]
        (is (<= 2 (count heartbeats)))
        (is (every? #(and (= "slow-node" (:state %))
                          (= 7 (:attempt %)))
                    heartbeats)))
      (finally
        (fs/delete-tree dir)))))

(deftest structured-step-operation-persists-the-advanced-context
  (let [root (temp-dir "tesseraft-structured-step")
        workflow-file (str (fs/path root "workflow.edn"))]
    (try
      (spit workflow-file
            "{:api-version \"tesseraft.workflow/v1\" :kind :workflow :metadata {:name \"structured-step\"} :defaults {:max-rounds 1 :state-timeout \"1m\"} :policies {:require-timeouts true :require-max-rounds true} :initial :start :states {:start {:type :deterministic :handler :noop/succeed :runtime {:timeout \"10s\"} :next :done} :done {:type :terminal :status :success}}}")
      (let [started (runtime/start! workflow-file {:workspace-root root :run-id "structured-step"})
            run-dir (get-in started [:run :dir])
            result (operations/apply-operation {:operation "run.step" :payload {:run_dir run-dir}})
            persisted (store/load-context run-dir)]
        (is (= true (:ok result)))
        (is (= "done" (get-in result [:result :run :status])))
        (is (= "done" (get-in persisted [:run :status])))
        (is (= :done (get-in persisted [:run :state]))))
      (finally
        (fs/delete-tree root)))))

(deftest cancel-stops-persisted-runtime-process-tree
  (let [dir (temp-dir "tesseraft-cancel")
        child (.start (ProcessBuilder. ["bash" "-lc" "sleep 60 & wait"]))
        pid (.pid child)
        process-enumeration-supported?
        (try
          (with-open [stream (java.lang.ProcessHandle/allProcesses)]
            (.findAny stream))
          true
          (catch Throwable _ false))
        descendant-count (fn []
                           (with-open [stream (.descendants (.toHandle child))]
                             (.count stream)))
        ctx {:workflow {:name "cancel-fixture"}
             :run {:id "cancel-test" :dir dir :status "running"
                   :state :slow :attempt 1 :updated-at (store/now)}}]
    (try
      (store/save-context! ctx)
      (store/write-json! (runtime/runtime-process-path dir)
                         {:pid pid :started_at (store/now)})
      (when process-enumeration-supported?
        (loop [remaining 40]
          (when (and (zero? (descendant-count)) (pos? remaining))
            (Thread/sleep 25)
            (recur (dec remaining)))))
      (let [cancelled (runtime/cancel! dir)
            event (last (filter #(= "run.cancelled" (:event %)) (read-events dir)))]
        (is (= "cancelled" (get-in cancelled [:run :status])))
        (is (not (.isAlive child)) "runtime root process is still alive")
        (is (some? event))
        (is (= true (:process_found event)))
        (is (= process-enumeration-supported? (:descendants_enumerated event)))
        (when process-enumeration-supported?
          (is (pos? (:descendants event))))
        (is (= true (:stopped event)))
        (is (not (fs/exists? (runtime/runtime-process-path dir)))))
      (finally
        (when (.isAlive child)
          (.destroyForcibly child))
        (fs/delete-tree dir)))))
