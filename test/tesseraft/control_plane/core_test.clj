(ns tesseraft.control-plane.core-test
  (:require
    [babashka.fs :as fs]
    [clojure.test :refer [deftest is testing]]
    [tesseraft.control-plane.core :as control-plane]))

(defn- temp-dir [prefix]
  (str (java.nio.file.Files/createTempDirectory
         prefix
         (make-array java.nio.file.attribute.FileAttribute 0))))

(deftest duplicate-run-ids-and-malformed-events-return-stable-errors
  (let [base (temp-dir "tesseraft-cp-test")
        dup-a (str base "/conflict/wf-a/dup")
        dup-b (str base "/conflict/wf-b/dup")
        malformed (str base "/malformed/wf-a/bad-events")]
    (try
      (doseq [dir [dup-a dup-b malformed]]
        (fs/create-dirs dir))
      (spit (str dup-a "/state.edn")
            (pr-str {:workflow {:name "wf-a" :version "v1"}
                     :run {:id "dup" :dir dup-a :status "done" :state :done}}))
      (spit (str dup-b "/state.edn")
            (pr-str {:workflow {:name "wf-b" :version "v1"}
                     :run {:id "dup" :dir dup-b :status "done" :state :done}}))
      (is (= "conflict"
             (get-in (control-plane/get-run
                       {:workspace-root base :runs-root "conflict"} "dup")
                     [:error :code])))
      (spit (str malformed "/state.edn")
            (pr-str {:workflow {:name "wf-a" :version "v1"}
                     :run {:id "bad-events" :dir malformed :status "done" :state :done}}))
      (spit (str malformed "/events.jsonl") "{bad json}\n")
      (is (= "parse_error"
             (get-in (control-plane/get-run-events
                       {:workspace-root base :runs-root "malformed"} "bad-events")
                     [:error :code])))
      (finally
        (fs/delete-tree base)))))

(deftest issue-artifacts-and-heartbeats-drive-failure-and-liveness
  (let [base (temp-dir "tesseraft-issues-liveness")
        run-dir (str base "/wf/issues-run")]
    (try
      (fs/create-dirs run-dir)
      (spit (str run-dir "/issues.json") "[]")
      (is (false? (control-plane/issues-artifact-has-issues? run-dir "issues.json")))
      (spit (str run-dir "/issues-real.json") "[{\"title\":\"x\"}]")
      (is (true? (control-plane/issues-artifact-has-issues? run-dir "issues-real.json")))
      (spit (str run-dir "/issues-map.json") "{\"issues\":[{\"title\":\"x\"}]}")
      (is (true? (control-plane/issues-artifact-has-issues? run-dir "issues-map.json")))
      (fs/create-dirs (str run-dir "/fragments/run-fragment/1"))
      (spit (str run-dir "/fragments/run-fragment/1/issues.json") "[{\"title\":\"x\"}]")
      (let [nested-artifact {:exists true :path "fragments/run-fragment/1/issues.json"}
            top-artifact {:exists true :path "issues-real.json"}
            summary {:status "done"}]
        (is (empty? (control-plane/failures-from-run summary [] [nested-artifact] run-dir)))
        (is (= 1 (count (control-plane/failures-from-run summary [] [top-artifact] run-dir)))))
      (let [old "2000-01-01T00:00:00Z"
            recent (str (java.time.Instant/now))
            summary {:status "running" :state :work :updated_at old}
            attempts [{:state "work" :status "running" :attempt 1}]]
        (is (= "orphaned"
               (:liveness (control-plane/derive-liveness summary attempts {:last-activity-at old}))))
        (is (= "executing"
               (:liveness (control-plane/derive-liveness summary attempts {:last-activity-at recent})))))
      (let [summary {:status "running" :state :work :updated_at "2999-01-01T00:00:00Z"}
            attempts [{:state "work" :status "running" :attempt 1}]]
        (is (= "executing" (:liveness (control-plane/derive-liveness summary attempts)))))
      (finally
        (fs/delete-tree base)))))

(deftest pending-approval-inbox-requires-current-blocked-state-and-attempt
  (let [base (temp-dir "tesseraft-pending-approvals")
        current (str base "/runs/review/current")
        stale (str base "/runs/review/stale")]
    (try
      (doseq [dir [current stale]]
        (fs/create-dirs (str dir "/approvals")))
      (spit (str current "/state.edn")
            (pr-str {:workflow {:name "review"}
                     :run {:id "current" :dir current :status "blocked" :state :gate :attempt 2}}))
      (spit (str current "/approvals/gate-2.json")
            "{\"approval_id\":\"gate-2\",\"run_id\":\"current\",\"state\":\"gate\",\"attempt\":2,\"question\":\"Ship?\",\"status\":\"pending\"}")
      (spit (str stale "/state.edn")
            (pr-str {:workflow {:name "review"}
                     :run {:id "stale" :dir stale :status "running" :state :after :attempt 2}}))
      (spit (str stale "/approvals/gate-1.json")
            "{\"approval_id\":\"gate-1\",\"run_id\":\"stale\",\"state\":\"gate\",\"attempt\":1,\"question\":\"Old?\",\"status\":\"pending\"}")
      (let [result (control-plane/get-pending-approvals {:workspace-root base :runs-root "runs"} "default")]
        (is (= 1 (count (:approvals result))))
        (is (= "current" (get (first (:approvals result)) "run_id")))
        (is (= "gate-2" (get (first (:approvals result)) "approval_id"))))
      (spit (str current "/approvals/gate-2-decision.json")
            "{\"approval_id\":\"gate-2\",\"decision\":\"approve\"}")
      (is (empty? (:approvals (control-plane/get-pending-approvals
                                {:workspace-root base :runs-root "runs"} "default"))))
      (finally
        (fs/delete-tree base)))))
