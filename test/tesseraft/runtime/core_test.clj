(ns tesseraft.runtime.core-test
  (:require
    [babashka.fs :as fs]
    [babashka.process :as p]
    [cheshire.core :as json]
    [clojure.string :as str]
    [clojure.test :refer [deftest is testing]]
    [tesseraft.runtime.approval-server :as approval-server]
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

(deftest approval-finalization-recovers-decision-before-step-once
  (let [root (temp-dir "tesseraft-approval-finalization")
        workflow-file (fs/path root "workflow.edn")]
    (try
      (spit (str workflow-file)
            "{:api-version \"tesseraft.workflow/v1\" :kind :workflow :metadata {:name \"approval-finalization\"} :defaults {:max-rounds 1 :state-timeout \"1m\"} :policies {:require-timeouts true :require-max-rounds true} :initial :gate :states {:gate {:type :approval :message \"Review?\" :timeout \"1m\" :presentation {:question \"Ready?\" :decisions [{:decision \"pass\" :label \"Pass\"}]} :transitions [{:when {:decision \"pass\"} :next :done}]} :done {:type :terminal :status :success}}}")
      (let [started (runtime/start! (str workflow-file) {:workspace-root root :run-id "approval-finalization"})
            wf (spec/read-workflow workflow-file)
            blocked (runtime/run-until-done! wf started 10)
            run-dir (get-in blocked [:run :dir])
            failure (try
                      (with-redefs [runtime/step! (fn [& _] (throw (ex-info "fault after decision" {})))]
                        (runtime/decide! run-dir "gate-1" "pass" nil nil))
                      nil
                      (catch clojure.lang.ExceptionInfo error error))
            prepared (store/read-json (runtime/approval-finalization-path blocked "gate-1"))]
        (is (= "fault after decision" (.getMessage failure)))
        (is (= "prepared" (:decision_status prepared)))
        (is (fs/exists? (runtime/approval-decision-path blocked :gate 1)))
        (is (= "blocked" (get-in (store/load-context run-dir) [:run :status])))
        (let [recovered (runtime/run-until-done! wf (store/load-context run-dir) 10)
              committed (store/read-json (runtime/approval-finalization-path recovered "gate-1"))
              events (read-events run-dir)
              event-ids (keep :event_id events)]
          (is (= "done" (get-in recovered [:run :status])))
          (is (= "committed" (:decision_status committed)))
          (is (= true (get-in recovered [:approval-finalizations "gate-1" :decision-committed])))
          (is (= (count event-ids) (count (set event-ids))))
          (is (= recovered (runtime/run-until-done! wf recovered 10)))))
      (finally (fs/delete-tree root)))))

(deftest git-diff-approval-server-rejects-with-durable-feedback-and-closes
  (let [root (temp-dir "tesseraft-git-review")
        repo (fs/path root "repo")
        workflow-file (fs/path root "workflow.edn")
        run! (fn [& command]
               (let [result @(p/process (vec command) {:dir (str repo) :out :string :err :string :continue true})]
                 (is (zero? (:exit result)) (:err result)) result))]
    (try
      (System/setProperty "tesseraft.test.adapter-exit-delay-ms" "30000")
      (fs/create-dirs repo)
      (run! "git" "init" "-q")
      (run! "git" "config" "user.name" "Review Test")
      (run! "git" "config" "user.email" "review@example.test")
      (spit (str (fs/path repo "review.txt")) "before\n")
      (run! "git" "add" "review.txt")
      (run! "git" "commit" "-qm" "base")
      (let [marker (fs/path root "external-diff-ran")
            external (fs/path root "external-diff.sh")]
        (spit (str external) (str "#!/bin/sh\ntouch '" marker "'\nexit 99\n"))
        (run! "chmod" "+x" (str external))
        (run! "git" "config" "diff.external" (str external)))
      (spit (str (fs/path repo "review.txt")) "after\n")
      (spit (str (fs/path root "prompt.md")) "Implement feedback")
      (spit (str (fs/path root "continue.md")) "Address the durable approval feedback")
      (spit (str workflow-file)
            (str "{:api-version \"tesseraft.workflow/v1\" :kind :workflow :metadata {:name \"git-review\"} "
                 ":defaults {:max-rounds 2 :state-timeout \"1m\"} :policies {:require-timeouts true :require-max-rounds true} "
                 ":initial :review :states {"
                 ":review {:type :approval :message \"Review tracked changes\" :timeout \"1m\" "
                 ":review-server {:kind :git-diff :max-diff-bytes 1048576} "
                 ":presentation {:question \"Ready?\" :decisions [{:decision \"pass\" :label \"Pass\"} {:decision \"reject\" :label \"Reject\" :requires-message true}]} "
                 ":transitions [{:when {:decision \"pass\"} :next :done} {:when {:decision \"reject\"} :effects [:merge-issues] :next :implement}]} "
                 ":implement {:type :agent :executor :pi-cli :prompt-template \"prompt.md\" :prompt-output \"prompts/generated/implement.md\" :runtime {:timeout \"1m\"} "
                 ":session {:mode :resumable :continuation-prompt-template \"continue.md\" :continuation-prompt-output \"prompts/generated/continue-{{run.attempt}}.md\"} "
                 ":outputs {:status {:path \"execution/status-{{run.attempt}}.json\" :required true}} :next :done} "
                 ":done {:type :terminal :status :success}}}"))
      (let [started (runtime/start! (str workflow-file) {:workspace-root root :run-id "git-review" :inputs {:repo-root (str repo)}})
            wf (spec/read-workflow workflow-file)
            blocked (runtime/run-until-done! wf started 10)
            run-dir (get-in blocked [:run :dir])
            request (store/read-json (fs/path run-dir "approvals" "review-1.json"))
            capability-file (fs/path run-dir "approval-adapters" "review" "1" "capability.json")]
        (is (= "blocked" (get-in blocked [:run :status])))
        (is (contains? #{"kqueue" "inotify"} (get-in request [:review_server :watch_provider])))
        (is (pos? (get-in request [:review_server :watch_count])))
        (is (= false (get-in request [:review_server :watch_overflow])))
        (is (not (fs/exists? (fs/path root "external-diff-ran")))
            "snapshot acquisition must never invoke configured external diff")
        (loop [remaining 100]
          (when (and (not (fs/exists? capability-file)) (pos? remaining))
            (Thread/sleep 50) (recur (dec remaining))))
        (is (fs/exists? capability-file)
            (str "adapter stdout: " (when (fs/exists? (fs/path (fs/parent capability-file) "adapter.log"))
                                        (slurp (str (fs/path (fs/parent capability-file) "adapter.log"))))
                 " adapter stderr: " (when (fs/exists? (fs/path (fs/parent capability-file) "adapter-error.log"))
                                         (slurp (str (fs/path (fs/parent capability-file) "adapter-error.log"))))))
        ;; SIGKILL leaves stale capability/owner metadata. A mutating resume
        ;; must prove the exact PID/start tuple absent and launch one replacement.
        (let [owner-file (fs/path run-dir "approval-adapters" "review" "1" "owner.json")
              initial-owner (store/read-json owner-file)
              initial-handle (.get (java.lang.ProcessHandle/of (long (:pid initial-owner))))]
          (.destroyForcibly initial-handle)
          (.get (.onExit initial-handle) 5 java.util.concurrent.TimeUnit/SECONDS)
          (runtime/run-until-done! wf (store/load-context run-dir) 1)
          (loop [remaining 100]
            (let [owner (store/read-json owner-file)]
              (when (and (or (= (:pid owner) (:pid initial-owner))
                             (not= "ready" (:status owner))
                             (not (fs/exists? capability-file)))
                         (pos? remaining))
                (Thread/sleep 50) (recur (dec remaining)))))
          (is (not= (:pid initial-owner) (:pid (store/read-json owner-file))))
          (is (= 1 (count (filter #(= "approval.adapter.recovered" (:event %)) (read-events run-dir))))))
        ;; Hold the canonical run lock so curl times out after sending a full
        ;; invalid submission. The adapter must record abort (not finish), let
        ;; canonical validation settle, close, and remain safely relaunchable.
        (let [owner-file (fs/path run-dir "approval-adapters" "review" "1" "owner.json")
              capability (store/read-json capability-file)
              owner (store/read-json owner-file)
              generation-one-worker (atom nil)
              acquired (promise)
              holder (future (store/with-run-lock run-dir #(do (deliver acquired true) (Thread/sleep 800))))]
          @acquired
          (let [aborted @(p/process ["curl" "-sS" "--max-time" "0.15" "-X" "POST"
                                     "-H" "content-type: application/json"
                                     "-H" (str "x-tesseraft-approval-token: " (:token capability))
                                     "--data-binary" "{\"decision\":\"invalid\"}"
                                     (str (:endpoint owner) "/api/decision")]
                                    {:out :string :err :string :continue true})]
            (is (not (zero? (:exit aborted)))))
          (loop [remaining 100]
            (let [current (store/read-json owner-file)]
              (when (and (or (not= "aborted" (:transport_status current))
                             (nil? (:supervisor_pid current)))
                         (pos? remaining))
                (Thread/sleep 25) (recur (dec remaining)))))
          (let [aborted-owner (store/read-json owner-file)
                drain-dir (fs/path (fs/parent owner-file) "drains")]
            (is (= "aborted" (:transport_status aborted-owner)))
            (is (integer? (:supervisor_pid aborted-owner)))
            @holder
            ;; Generation 1 must be durably claimed before the worker is killed;
            ;; adapter-side reissue then claims generation 2 under the same lock.
            (loop [remaining 150]
              (let [drains (when (fs/exists? drain-dir) (vec (fs/glob drain-dir "*.json")))
                    receipt (when (= 1 (count drains)) (store/read-json (first drains)))]
                (when (and (or (not= 1 (:drain_generation receipt))
                               (not= "claimed" (:phase receipt)))
                           (pos? remaining))
                  (Thread/sleep 10) (recur (dec remaining)))))
            (let [receipt (store/read-json (first (fs/glob drain-dir "*.json")))
                  candidate (java.lang.ProcessHandle/of (long (:worker_pid receipt)))
                  worker (when (.isPresent candidate) (.get candidate))]
              (is (= 1 (:drain_generation receipt)))
              (is (contains? (set (:supervisor_candidate_pids aborted-owner)) (:worker_pid receipt))
                  "durable worker must be one of the detached candidates")
              (reset! generation-one-worker (:worker_pid receipt))
              (is (some? worker) "generation-1 drain worker exited before kill barrier")
              (when worker
                (.destroyForcibly worker)))
            ;; Kill the adapter immediately after generation 1; do not await
            ;; child reaping because the Node parent owns that zombie boundary. The waiting
            ;; candidate must survive both failures, claim generation 2, and
            ;; complete against exact adapter absence.
            (let [candidate (java.lang.ProcessHandle/of (long (:pid aborted-owner)))
                  adapter (when (.isPresent candidate) (.get candidate))]
              (is (some? adapter) "adapter exited before the dual-kill barrier")
              (when adapter
                (.destroyForcibly adapter)
                (.get (.onExit adapter) 5 java.util.concurrent.TimeUnit/SECONDS)))
            (loop [remaining 150]
              (let [receipt (store/read-json (first (fs/glob drain-dir "*.json")))]
                (when (and (< (or (:drain_generation receipt) 0) 2) (pos? remaining))
                  (Thread/sleep 10) (recur (dec remaining)))))
            (let [receipt (store/read-json (first (fs/glob drain-dir "*.json")))]
              (is (= 2 (:drain_generation receipt)))
              (is (not= @generation-one-worker (:worker_pid receipt))))
            ;; No mutating inspection/resume follows. Generation 2 must finish
            ;; exact cleanup and autonomously relaunch the pending endpoint.
            (loop [remaining 200]
              (let [current (store/read-json owner-file)
                    drains (when (fs/exists? drain-dir) (vec (fs/glob drain-dir "*.json")))]
                (when (and (or (= (:pid current) (:pid owner))
                               (not= "ready" (:status current))
                               (not (fs/exists? capability-file))
                               (empty? drains)
                               (not= "complete" (:lifecycle_status (store/read-json (first drains)))))
                           (pos? remaining))
                  (Thread/sleep 50) (recur (dec remaining)))))
            (let [current (store/read-json owner-file)
                  drains (vec (fs/glob drain-dir "*.json"))
                  receipt (when (= 1 (count drains)) (store/read-json (first drains)))]
              (is (not= (:pid owner) (:pid current)))
              (is (= "ready" (:status current)))
              (is (= 1 (count drains)))
              (is (= 2 (:drain_generation receipt)))
              (is (= "aborted" (:transport_status receipt)))
              (is (= true (:listener_absent receipt)))
              (is (= "complete" (:lifecycle_status receipt))))))
        (when (fs/exists? capability-file)
         (let [capability (store/read-json capability-file)
              owner (store/read-json (fs/path run-dir "approval-adapters" "review" "1" "owner.json"))
              _ (is (str/starts-with? (:endpoint owner) "http://127.0.0.1:"))
              unauthorized @(p/process ["curl" "-sS" "-o" "/dev/null" "-w" "%{http_code}"
                                        (str (:endpoint owner) "/api/review")]
                                       {:out :string :err :string :continue true})
              _ (is (= "401" (:out unauthorized)))
              page @(p/process ["curl" "-sS" (:launch_url capability)]
                               {:out :string :err :string :continue true})
              _ (is (str/includes? (:out page) "Review current Git changes"))
              anchor (-> request :review_server :anchors vals first)
              payload (json/generate-string {:decision "reject" :message "Please revise this line"
                                             :annotations [{:id "a1" :artifact_path (get-in request [:review_server :evidence_path])
                                                            :body "Keep the original contract" :anchor anchor}]})
              response @(p/process ["curl" "-sS" "-X" "POST" "-H" "content-type: application/json"
                                    "-H" (str "x-tesseraft-approval-token: " (:token capability))
                                    "--data-binary" payload (str (:endpoint owner) "/api/decision")]
                                   {:out :string :err :string :continue true})]
          (is (zero? (:exit response)) (:err response))
          (is (= true (:ok (json/parse-string (:out response) true))))
          (is (= "reject" (:decision (store/read-json (fs/path run-dir "approvals" "review-1-decision.json")))))
          (is (= "human-approval" (:source (first (store/read-json (fs/path run-dir "issues.json"))))))
          (is (= :implement (get-in (store/load-context run-dir) [:run :state])))
          (loop [remaining 100]
            (when (and (fs/exists? capability-file) (pos? remaining))
              (Thread/sleep 50) (recur (dec remaining))))
          (is (not (fs/exists? capability-file)))
          (let [owner-file (fs/path run-dir "approval-adapters" "review" "1" "owner.json")]
            (loop [remaining 100]
              (let [candidate (store/read-json owner-file)
                    handle (java.lang.ProcessHandle/of (long (:pid candidate)))
                    absent? (or (not (.isPresent handle)) (not (.isAlive (.get handle))))]
                (when (and (not (and (= "stopped" (:status candidate)) absent?)) (pos? remaining))
                  (Thread/sleep 50) (recur (dec remaining)))))
            (let [stopped-owner (store/read-json owner-file)
                  handle (java.lang.ProcessHandle/of (long (:pid stopped-owner)))
                  drains (mapv store/read-json
                               (fs/glob (fs/path (fs/parent owner-file) "drains") "*.json"))
                  finished (first (filter #(= "finished" (:transport_status %)) drains))
                  finalization (store/read-json (fs/path run-dir "approval-finalizations" "review-1.json"))]
              (is (= "stopped" (:status stopped-owner)))
              (is (or (not (.isPresent handle)) (not (.isAlive (.get handle)))))
              (is (= #{"aborted" "finished"} (set (map :transport_status drains))))
              (is (every? #(and (= "complete" (:lifecycle_status %))
                                (= true (:listener_absent %))) drains))
              (is (= "complete" (:lifecycle_status finalization)))
              (is (= "finished" (:transport_status finalization)))
              (is (= (:submission_id finished) (:drain_submission_id finalization)))
              (is (= (:drain_generation finished) (:drain_generation finalization)))
              (is (= "requested" (:resume_handoff_status finalization))))))))
      (finally
        (System/clearProperty "tesseraft.test.adapter-exit-delay-ms")
        (when (fs/exists? (fs/path root ".agent-runs" "git-review" "git-review" "state.edn"))
          (approval-server/cleanup! (store/load-context (fs/path root ".agent-runs" "git-review" "git-review"))))
        (fs/delete-tree root)))))

(deftest git-diff-snapshot-rejects-conversion-before-helper-or-artifacts
  (let [root (temp-dir "tesseraft-git-conversion")
        repo (fs/path root "repo")
        run-dir (fs/path root "run")
        marker (fs/path root "filter-ran")
        filter-script (fs/path root "filter.sh")
        run! (fn [& command]
               @(p/process (vec command) {:dir (str repo) :out :string :err :string :continue true}))
        ctx {:run {:dir (str run-dir)} :inputs {:repo-root (str repo)}}]
    (try
      (fs/create-dirs repo)
      (fs/create-dirs run-dir)
      (run! "git" "init" "-q")
      (run! "git" "config" "user.name" "Review Test")
      (run! "git" "config" "user.email" "review@example.test")
      (spit (str (fs/path repo "review.txt")) "before\n")
      (run! "git" "add" "review.txt")
      (run! "git" "commit" "-qm" "base")
      (spit (str filter-script) (str "#!/bin/sh\ntouch '" marker "'\ncat\n"))
      (run! "chmod" "+x" (str filter-script))
      (run! "git" "config" "filter.review.clean" (str filter-script))
      (spit (str (fs/path repo ".gitattributes")) "*.txt filter=review\n")
      (spit (str (fs/path repo "review.txt")) "after\n")
      (let [error (try (approval-server/snapshot-diff! ctx "review-1" 1048576) nil
                       (catch clojure.lang.ExceptionInfo failure failure))]
        (is (= :unsupported_git_conversion (:code (ex-data error))))
        (is (not (fs/exists? marker)) "configured clean helper must not execute")
        (is (not (fs/exists? (approval-server/evidence-path ctx "review-1")))))
      (finally (fs/delete-tree root)))))

(deftest git-diff-snapshot-watches-span-publication-and-reject-restored-mutations
  (doseq [mutation [:file :ancestor :index :config]]
    (testing (name mutation)
      (let [root (temp-dir (str "tesseraft-git-watch-" (name mutation)))
            repo (fs/path root "repo")
            nested (fs/path repo "src")
            tracked (fs/path nested "review.txt")
            outside (fs/path root "outside")
            barrier (fs/path root "barrier")
            run-dir (fs/path root "run")
            evidence (fs/path run-dir "approval-evidence" "review-1" "changes.diff")
            run! (fn [& command]
                   (let [result @(p/process (vec command) {:dir (str repo) :out :string :err :string :continue true})]
                     (is (zero? (:exit result)) (:err result)) result))
            write-bytes! (fn [target bytes]
                           (with-open [out (java.io.FileOutputStream. (str target))]
                             (.write out bytes)))]
        (try
          (fs/create-dirs nested)
          (fs/create-dirs outside)
          (fs/create-dirs run-dir)
          (run! "git" "init" "-q")
          (run! "git" "config" "user.name" "Watch Test")
          (run! "git" "config" "user.email" "watch@example.test")
          (spit (str tracked) "before\n")
          (run! "git" "add" "src/review.txt")
          (run! "git" "commit" "-qm" "base")
          (spit (str tracked) "after\n")
          (spit (str (fs/path outside "review.txt")) "OUTSIDE-SENTINEL\n")
          (System/setProperty "tesseraft.test.snapshot-barrier-dir" (str barrier))
          (let [ctx {:run {:dir (str run-dir)} :inputs {:repo-root (str repo)}}
                result (future
                         (try
                           (approval-server/snapshot-diff! ctx "review-1" 1048576)
                           (catch Throwable error error)))]
            (loop [remaining 500]
              (when (and (not (fs/exists? (fs/path barrier "prepared.ready"))) (pos? remaining))
                (Thread/sleep 10)
                (recur (dec remaining))))
            (is (fs/exists? (fs/path barrier "prepared.ready")) "helper did not reach prepared barrier")
            (spit (str (fs/path barrier "prepared.continue")) "continue\n")
            (loop [remaining 500]
              (when (and (not (fs/exists? (fs/path barrier "published.ready"))) (pos? remaining))
                (Thread/sleep 10)
                (recur (dec remaining))))
            (is (fs/exists? (fs/path barrier "published.ready")) "helper did not reach publication barrier")
            (is (fs/exists? evidence) "candidate evidence was not atomically installed at the barrier")
            (case mutation
              :file (do (spit (str tracked) "transient\n")
                        (spit (str tracked) "after\n"))
              :ancestor (let [original (fs/path repo "src.original")]
                          (fs/move nested original)
                          (let [linked @(p/process ["ln" "-s" (str outside) (str nested)]
                                                  {:out :string :err :string :continue true})]
                            (is (zero? (:exit linked)) (:err linked)))
                          (fs/delete nested)
                          (fs/move original nested))
              :index (let [index-path (fs/path repo ".git" "index")
                           original (java.nio.file.Files/readAllBytes (.toPath (fs/file index-path)))]
                       (run! "git" "add" "src/review.txt")
                       (write-bytes! index-path original))
              :config (let [config-path (fs/path repo ".git" "config")
                            original (java.nio.file.Files/readAllBytes (.toPath (fs/file config-path)))]
                        (spit (str config-path) (str (slurp (str config-path)) "\n[alias]\n  unsafe = status\n"))
                        (write-bytes! config-path original)))
            (spit (str (fs/path barrier "published.continue")) "continue\n")
            (let [failure (deref result 10000 ::timeout)]
              (is (not= ::timeout failure) "snapshot did not leave the publication barrier")
              (is (instance? Throwable failure))
              (is (= :unstable_worktree_snapshot (:code (ex-data failure))))
              (is (not (fs/exists? evidence)) "failed publication left durable evidence")
              (is (not (fs/exists? (fs/path run-dir "approvals"))) "failed snapshot created an approval request")
              (is (not (fs/exists? (fs/path run-dir "approval-adapters"))) "failed snapshot launched an adapter")
              (is (not (fs/exists? (fs/path run-dir "events.jsonl"))) "failed snapshot emitted an event")
              (is (not (str/includes? (str failure) "OUTSIDE-SENTINEL")))))
          (finally
            (System/clearProperty "tesseraft.test.snapshot-barrier-dir")
            (fs/delete-tree root)))))))

(deftest runtime-state-claim-rejects-a-competing-live-owner
  (let [dir (temp-dir "tesseraft-runtime-claim")
        ctx {:workflow {:name "claim-fixture"}
             :run {:id "claim-test" :dir dir :status "running" :state :slow :attempt 1
                   :issues-file (str (fs/path dir "issues.json")) :updated-at (store/now)}}
        expression (str "(require '[tesseraft.runtime.process :as p]) "
                        "(p/register! " (pr-str dir) ") (Thread/sleep 60000)")
        child (p/process ["bb" "--classpath" (str (fs/path (System/getProperty "user.dir") "src"))
                          "-e" expression]
                         {:out :string :err :string :continue true})]
    (try
      (store/save-context! ctx)
      (loop [remaining 100]
        (when (and (nil? (:runtime-claim (store/load-context dir))) (pos? remaining))
          (Thread/sleep 50) (recur (dec remaining))))
      (let [claimed (store/load-context dir)
            marker (store/read-json (runtime/runtime-process-path dir))
            conflict (try (runtime/register-runtime-process! dir) nil
                          (catch clojure.lang.ExceptionInfo error error))]
        (is (= 3 (:version marker)))
        (is (= (:pid marker) (get-in claimed [:runtime-claim :pid])))
        (is (= 0 (get-in claimed [:runtime-claim :cancel-generation])))
        (is (= :runtime_claim_conflict (:code (ex-data conflict))))
        (is (not= (.pid (java.lang.ProcessHandle/current)) (get-in claimed [:runtime-claim :pid]))))
      (let [stopped (runtime/stop-runtime-process! dir)]
        (is (= true (:stopped stopped))))
      (finally
        (when (.isAlive ^java.lang.Process (:proc child)) (.destroyForcibly ^java.lang.Process (:proc child)))
        (fs/delete-tree dir)))))

(deftest cancellation-fence-rejects-stale-claim-and-save-before-effects
  (let [dir (temp-dir "tesseraft-runtime-fence")
        ctx {:workflow {:name "fence-fixture"}
             :execution-cancel-generation 0
             :run {:id "fence-test" :dir dir :status "running" :state :slow :attempt 1
                   :issues-file (str (fs/path dir "issues.json")) :updated-at (store/now)}}]
    (try
      (store/save-context! ctx)
      (let [pid (runtime/register-runtime-process! dir)
            claimed (store/load-context dir)]
        (is (= true (runtime/assert-runtime-active! claimed)))
        (is (= :executing (get-in (store/load-context dir) [:runtime-claim :phase])))
        (store/with-run-lock dir
          (fn []
            (let [current (store/load-context dir)
                  generation (inc (:execution-cancel-generation current))
                  fenced (-> current
                             (assoc :execution-cancel-generation generation
                                    :execution-cancel-in-progress generation)
                             (update :runtime-claim assoc :phase :cancel-requested
                                     :cancel-generation generation
                                     :cancel-requested-at (store/now)))]
              (store/save-context! fenced))))
        (let [barrier (try (runtime/assert-runtime-active! claimed) nil
                           (catch clojure.lang.ExceptionInfo error error))
              stale-save (try (store/save-context! claimed) nil
                              (catch clojure.lang.ExceptionInfo error error))]
          (is (= :runtime_claim_lost (:code (ex-data barrier))))
          (is (= :runtime_cancel_fenced (:code (ex-data stale-save))))
          (is (empty? (filter #(= "node.started" (:event %)) (read-events dir)))))
        (runtime/unregister-runtime-process! dir pid))
      (finally (fs/delete-tree dir)))))

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
        (is (= 1 (:execution-cancel-generation cancelled)))
        (is (nil? (:execution-cancel-in-progress cancelled)))
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
