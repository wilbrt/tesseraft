(ns tesseraft.runtime.core-test
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.string :as str]
    [clojure.test :refer [deftest is testing]]
    [tesseraft.runtime.core :as runtime]
    [tesseraft.runtime.liveness :as liveness]
    [tesseraft.runtime.operations :as operations]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]))

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

(deftest approval-decision-validates-before-write-and-carries-human-feedback
  (let [root (temp-dir "tesseraft-approval-decision")
        workflow-file (str (fs/path root "workflow.edn"))]
    (try
      (spit workflow-file
            "{:api-version \"tesseraft.workflow/v1\" :kind :workflow :metadata {:name \"approval-feedback\"} :defaults {:max-rounds 1 :state-timeout \"1m\"} :policies {:require-timeouts true :require-max-rounds true} :initial :gate :states {:gate {:type :approval :message \"Review?\" :timeout \"1m\" :presentation {:question \"Ready?\" :artifacts [{:path \"review.diff\" :kind \"diff\"}] :decisions [{:decision \"approve\" :label \"Approve\"} {:decision \"changes-requested\" :label \"Request changes\" :requires-message true}]} :transitions [{:when {:decision \"approve\"} :next :after} {:when {:decision \"changes-requested\"} :next :after}]} :after {:type :timer :duration \"1ms\" :runtime {:timeout \"10s\"} :next :done} :done {:type :terminal :status :success}}}")
      (let [started (runtime/start! workflow-file {:workspace-root root :run-id "approval-feedback"})
            run-dir (get-in started [:run :dir])
            wf (spec/read-workflow workflow-file)
            blocked (runtime/run-until-done! wf started 10)
            decision-file (fs/path run-dir "approvals" "gate-1-decision.json")]
        (is (= "blocked" (get-in blocked [:run :status])))
        (let [invalid (runtime/decide! run-dir "gate-1" "banana" nil nil)]
          (is (= "invalid_decision" (get-in invalid [:error :code])))
          (is (not (fs/exists? decision-file))))
        (let [missing-message (runtime/decide! run-dir "gate-1" "changes-requested" nil nil)]
          (is (= "message_required" (get-in missing-message [:error :code])))
          (is (not (fs/exists? decision-file))))
        (let [wrong-artifact (runtime/decide! run-dir "gate-1" "approve" nil
                                               [{:artifact_path "other.diff" :body "Not shown" :anchor {:kind "diff"}}]
                                               nil)]
          (is (= "invalid_annotation" (get-in wrong-artifact [:error :code])))
          (is (not (fs/exists? decision-file))))
        (let [annotations [{:artifact_path "review.diff"
                            :body "Cover the timeout branch"
                            :anchor {:kind "diff" :file "src/core.clj" :side "new" :line 42}}]
              accepted (runtime/decide! run-dir "gate-1" "changes-requested"
                                        "Reject for reason" annotations nil)
              persisted (store/load-context run-dir)]
          (is (= :after (get-in accepted [:run :state])))
          (is (= "running" (get-in accepted [:run :status])))
          (is (= "Reject for reason" (get-in persisted [:last-approval :message])))
          (is (= annotations (get-in persisted [:last-approval :annotations])))
          (is (= "changes-requested" (:decision (store/read-json decision-file))))
          (is (= "done" (get-in (runtime/run-until-done! wf persisted 10) [:run :status])))))
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
