(ns tesseraft.runtime.process
  (:require [babashka.fs :as fs]
            [babashka.process :as process]
            [cheshire.core :as json]
            [clojure.string :as str]
            [tesseraft.runtime.store :as store]))

(defn runtime-process-path [run-dir] (fs/path run-dir "runtime-process.json"))

(defn- process-start [handle]
  (some-> handle .info .startInstant (.orElse nil) str))

(defn- claim-owner [claim]
  (let [pid (:pid claim)
        candidate (when (and (integer? pid) (pos? pid)) (java.lang.ProcessHandle/of (long pid)))
        handle (when (and candidate (.isPresent candidate)) (.get candidate))
        actual (some-> handle process-start)]
    {:handle handle :exact-live (boolean (and handle (.isAlive handle) (= actual (:process-started-at claim))))}))

(defn- marker-live? [record]
  (let [pid (:pid record)
        candidate (when (and (integer? pid) (pos? pid)) (java.lang.ProcessHandle/of (long pid)))
        handle (when (and candidate (.isPresent candidate)) (.get candidate))]
    (boolean
      (and handle (.isAlive handle)
           (or (= 2 (:version record))
               (= (process-start handle) (:process_started_at record)))))))

(defn- current-process-record []
  (let [handle (java.lang.ProcessHandle/current)]
    {:pid (.pid handle) :process-started-at (process-start handle)}))

(defn- lease-valid? [launcher]
  (try
    (and (:lease-deadline launcher)
         (.isAfter (java.time.Instant/parse (:lease-deadline launcher)) (java.time.Instant/now)))
    (catch Throwable _ false)))

(defn- node-started? [run-dir execution-id]
  (let [path (fs/path run-dir "events.jsonl")]
    (boolean
      (when (fs/exists? path)
        (some #(and (= "node.started" (:event %)) (= execution-id (:execution_id %)))
              (map #(json/parse-string % true)
                   (remove str/blank? (str/split-lines (slurp (str path))))))))))

(defn- focused-cleanup-pending [run-dir]
  (let [root (fs/path run-dir "approval-finalizations")]
    (when (fs/exists? root)
      (some (fn [path]
              (let [record (store/read-json path)
                    approval-id (:approval_id record)
                    request-path (fs/path run-dir "approvals" (str approval-id ".json"))
                    focused? (and (fs/exists? request-path)
                                  (:review_server (store/read-json request-path)))]
                (when (and focused? (= "committed" (:decision_status record))
                           (not= "complete" (:lifecycle_status record)))
                  approval-id)))
            (fs/glob root "*.json")))))

(defn request-handoff-intent
  "Add one deterministic requested approval-resume intent to a context while
  its caller holds the run lock that completes focused adapter lifecycle."
  [ctx approval-id]
  (let [intent-id (str approval-id "/resume")]
    (if (get-in ctx [:execution-intents intent-id])
      ctx
      (let [generation 1
            cancel-generation (or (:execution-cancel-generation ctx) 0)
            intent {:version 1 :kind :approval-resume :intent-id intent-id
                    :handoff-id intent-id :generation generation :phase :requested
                    :operation "run.resume" :options {:max_steps 100}
                    :expected {:state (get-in ctx [:run :state])
                               :attempt (get-in ctx [:run :attempt])
                               :status (get-in ctx [:run :status])
                               :approval-id approval-id :lifecycle-status :complete}
                    :cancel-generation cancel-generation
                    :consumed-event-id (str intent-id "/" generation "/consumed")
                    :requested-at (store/now)}]
        (-> ctx
            (assoc-in [:execution-intents intent-id] intent)
            (assoc :active-execution-intent-id intent-id))))))

(defn lease-intent!
  "Durably request and lease one exact pre-spawn execution generation. A dead
  pre-step launcher/owner is reissued; a live owner or post-node-start death
  fails closed. The caller must remain alive while spawning the bootstrap child."
  [run-dir operation options]
  (let [launcher (current-process-record)
        spawn-nonce (str (java.util.UUID/randomUUID))]
    (store/with-run-lock run-dir
      (fn []
        (let [ctx (store/load-context run-dir)
              active-id (:active-execution-intent-id ctx)
              existing (get-in ctx [:execution-intents active-id])
              phase (:phase existing)
              live-launcher? (and (= :launching phase)
                                  (lease-valid? (:launcher existing))
                                  (:exact-live (claim-owner (:launcher existing))))
              live-owner? (and (#{:claimed :executing} phase)
                               (:exact-live (claim-owner (:owner existing))))
              started? (and existing (:execution-id (:owner existing))
                            (node-started? run-dir (:execution-id (:owner existing))))]
          (when (:execution-cancel-in-progress ctx)
            (throw (ex-info "Run cancellation is in progress"
                            {:code :runtime_cancel_in_progress})))
          (when-let [approval-id (focused-cleanup-pending run-dir)]
            (throw (ex-info "Focused approval cleanup is not complete"
                            {:code :approval_cleanup_pending :approval-id approval-id})))
          (when (or live-launcher? live-owner?)
            (throw (ex-info "Run already has a live execution intent owner"
                            {:code :execution_intent_conflict :intent-id active-id})))
          (let [requested-existing? (= :requested phase)
                reissue? (and existing (#{:launching :claimed} phase) (not started?))
                recovery? (and existing (#{:claimed :executing} phase) started?)
                intent-id (if (or requested-existing? reissue?) active-id (str (java.util.UUID/randomUUID)))
                generation (cond requested-existing? (:generation existing)
                                 reissue? (inc (:generation existing))
                                 :else 1)
                cancel-generation (or (:execution-cancel-generation ctx) 0)
                expected {:state (get-in ctx [:run :state])
                          :attempt (get-in ctx [:run :attempt])
                          :status (get-in ctx [:run :status])}
                requested (cond
                            requested-existing? existing
                            reissue? (-> existing
                                         (assoc :generation generation :phase :requested
                                                :cancel-generation cancel-generation
                                                :consumed-event-id (str intent-id "/" generation "/consumed")
                                                :requested-at (store/now)
                                                :launcher nil :owner nil :consumed false)
                                         (dissoc :launching-at :claimed-at :executing-at :finished-at
                                                 :abandoned-at :cancel-requested-at :abandon-reason))
                            :else {:version 1 :kind :manual :intent-id intent-id
                                   :generation generation :phase :requested
                                   :operation operation :options options :expected expected
                                   :cancel-generation cancel-generation
                                   :consumed-event-id (str intent-id "/" generation "/consumed")
                                   :requested-at (store/now)})
                requested-base (-> ctx
                                   (assoc-in [:execution-intents intent-id] requested)
                                   (assoc :active-execution-intent-id intent-id))
                requested-ctx (if recovery?
                                (-> requested-base
                                    (assoc-in [:execution-intents active-id :phase] :abandoned)
                                    (assoc-in [:execution-intents active-id :abandon-reason] :owner-died-after-node-started)
                                    (assoc-in [:execution-intents active-id :abandoned-at] (store/now))
                                    (assoc-in [:execution-intents intent-id :kind] :orphan-recovery))
                                requested-base)
                launching (assoc requested :phase :launching
                                 :launcher (assoc launcher :spawn-nonce spawn-nonce
                                                  :lease-deadline (str (.plusSeconds (java.time.Instant/now) 60)))
                                 :launching-at (store/now))
                launching-ctx (assoc-in requested-ctx [:execution-intents intent-id] launching)]
            (binding [store/*allow-execution-intent-update* true]
              (store/save-context! requested-ctx)
              (store/save-context! launching-ctx))
            (store/event-once! launching-ctx
              {:event "execution.intent.requested"
               :event_id (str intent-id "/" generation "/requested")
               :intent_id intent-id :generation generation :operation operation
               :cancel_generation cancel-generation})
            {:version 1 :run-dir (str run-dir) :intent-id intent-id
             :generation generation :spawn-nonce spawn-nonce
             :cancel-generation cancel-generation :operation (:operation requested)
             :options (:options requested)}))))))

(defn bootstrap-intent!
  "Claim one exact launching intent in the child before full workflow load."
  [{:keys [run-dir intent-id generation spawn-nonce cancel-generation]}]
  (let [child (current-process-record)
        execution-id (str (java.util.UUID/randomUUID))]
    (store/with-run-lock run-dir
      (fn []
        (let [ctx (store/load-context run-dir)
              intent (get-in ctx [:execution-intents intent-id])
              launcher (:launcher intent)
              existing (:runtime-claim ctx)
              existing-live? (and existing (:exact-live (claim-owner existing)))
              marker-path (runtime-process-path run-dir)
              marker (when (fs/exists? marker-path) (store/read-json marker-path))
              marker-live? (and marker (marker-live? marker))
              exact? (and (= generation (:generation intent))
                          (= :launching (:phase intent))
                          (= spawn-nonce (:spawn-nonce launcher))
                          (= cancel-generation (:cancel-generation intent))
                          (= cancel-generation (or (:execution-cancel-generation ctx) 0))
                          (= (select-keys (:expected intent) [:state :attempt :status])
                             {:state (get-in ctx [:run :state])
                              :attempt (get-in ctx [:run :attempt])
                              :status (get-in ctx [:run :status])})
                          (or (not= :approval-resume (:kind intent))
                              (let [approval-id (get-in intent [:expected :approval-id])
                                    path (fs/path run-dir "approval-finalizations" (str approval-id ".json"))]
                                (and (fs/exists? path)
                                     (= "complete" (:lifecycle_status (store/read-json path))))))
                          (lease-valid? launcher)
                          (:exact-live (claim-owner launcher))
                          (nil? (:execution-cancel-in-progress ctx)))]
          (when-not exact?
            (throw (ex-info "Execution intent bootstrap envelope is stale"
                            {:code :execution_intent_stale :intent-id intent-id :generation generation})))
          (when (and existing-live?
                     (not= [(:pid child) (:process-started-at child)]
                           [(:pid existing) (:process-started-at existing)]))
            (throw (ex-info "Run already has a live runtime owner"
                            {:code :runtime_claim_conflict :owner (:execution-id existing)})))
          (when marker-live?
            (throw (ex-info "A live compatibility runtime marker blocks bootstrap claim"
                            {:code :runtime_marker_conflict :pid (:pid marker)
                             :version (:version marker)})))
          (when marker
            (fs/move marker-path
                     (fs/path run-dir (str "runtime-process.stale-" (java.util.UUID/randomUUID) ".json"))))
          (let [claim (merge child {:version 1 :execution-id execution-id
                                    :intent-id intent-id :intent-generation generation
                                    :phase :claimed :cancel-generation cancel-generation
                                    :claimed-at (store/now)})
                claimed-intent (assoc intent :phase :claimed :owner claim :claimed-at (store/now))
                claimed (-> ctx
                            (assoc :runtime-claim claim)
                            (assoc-in [:execution-intents intent-id] claimed-intent))]
            (binding [store/*allow-runtime-claim-replacement* true
                      store/*allow-execution-intent-update* true]
              (store/save-context! claimed))
            (store/write-json! (runtime-process-path run-dir)
                               {:version 3 :execution_id execution-id :pid (:pid child)
                                :process_started_at (:process-started-at child)
                                :child_pids [] :started_at (store/now)})
            (store/event-once! claimed {:event "runtime.claimed"
                                        :event_id (str execution-id "/claimed")
                                        :execution_id execution-id :intent_id intent-id
                                        :intent_generation generation :pid (:pid child)
                                        :cancel_generation cancel-generation})
            (:pid child)))))))

(defn launch-intent!
  "Lease an intent, spawn one minimal bootstrap child, and return its bounded
  structured result. The launcher stays alive until the child exits."
  [run-dir operation options]
  (let [envelope (lease-intent! run-dir operation options)
        root (or (System/getenv "TESSERAFT_INSTALL_ROOT") (System/getProperty "user.dir"))
        command [(str (fs/path root "bin" "tesseraft")) "run" "bootstrap"]
        result @(process/process command {:in (json/generate-string envelope)
                                          :out :string :err :string :continue true})
        stderr (subs (str (:err result)) 0 (min 1000 (count (str (:err result)))))
        payload (try (json/parse-string (or (:out result) "") true)
                     (catch Throwable _ nil))]
    (when (or (not (zero? (:exit result))) (nil? payload) (:error payload))
      (throw (ex-info (str "Execution bootstrap child failed"
                           (when-not (str/blank? stderr) (str ": " (str/trim stderr))))
                      {:code :execution_bootstrap_failed :exit (:exit result)
                       :stderr stderr
                       :result payload :intent-id (:intent-id envelope)
                       :generation (:generation envelope)})))
    payload))

(defn register!
  "Atomically claim runtime execution in state.edn before a runner may step.
  runtime-process.json v3 is a derived compatibility mirror, never authority."
  [run-dir]
  (let [current (java.lang.ProcessHandle/current)
        pid (.pid current)
        started (process-start current)
        execution-id (str (java.util.UUID/randomUUID))]
    (store/with-run-lock run-dir
      (fn []
        (let [ctx (store/load-context run-dir)
              existing (:runtime-claim ctx)
              cancel-generation (or (:execution-cancel-generation ctx) 0)
              {:keys [exact-live]} (when existing (claim-owner existing))]
          (when (:execution-cancel-in-progress ctx)
            (throw (ex-info "Run cancellation is in progress"
                            {:code :runtime_cancel_in_progress
                             :generation (:execution-cancel-in-progress ctx)})))
          (when (and exact-live (not (and (= pid (:pid existing))
                                          (= started (:process-started-at existing)))))
            (throw (ex-info "Run is already owned by a live runtime execution"
                            {:code :runtime_claim_conflict :owner (:execution-id existing)})))
          (if (and exact-live (= pid (:pid existing)) (= started (:process-started-at existing)))
            pid
            (let [claim {:version 1 :execution-id execution-id :pid pid
                         :process-started-at started :phase :claimed
                         :cancel-generation cancel-generation :claimed-at (store/now)}
                  claimed (assoc ctx :runtime-claim claim)]
              ;; Replacement is permitted only here, after the exact prior
              ;; PID/start owner was proven absent while holding the run lock.
              (binding [store/*allow-runtime-claim-replacement* true]
                (store/save-context! claimed))
              (store/write-json! (runtime-process-path run-dir)
                                 {:version 3 :execution_id execution-id :pid pid
                                  :process_started_at started :child_pids [] :started_at (store/now)})
              (store/event-once! claimed {:event "runtime.claimed" :event_id (str execution-id "/claimed")
                                          :execution_id execution-id :pid pid
                                          :cancel_generation cancel-generation})
              pid)))))))

(defn assert-active!
  "Compare the caller's durable execution claim and cancellation fence under
  the run lock immediately before a workflow step or external effect."
  [ctx]
  (when-let [expected (:runtime-claim ctx)]
    (let [run-dir (get-in ctx [:run :dir])
          current (java.lang.ProcessHandle/current)
          pid (.pid current)
          started (process-start current)]
      (store/with-run-lock run-dir
        (fn []
          (let [durable (store/load-context run-dir)
                claim (:runtime-claim durable)
                intent-id (:intent-id claim)
                intent (get-in durable [:execution-intents intent-id])
                generation (or (:execution-cancel-generation durable) 0)
                exact? (and (= (:execution-id expected) (:execution-id claim))
                            (= pid (:pid claim))
                            (= started (:process-started-at claim))
                            (= (:cancel-generation claim) generation)
                            (or (nil? intent-id)
                                (and (= (:intent-generation claim) (:generation intent))
                                     (#{:claimed :executing} (:phase intent))
                                     (= (:execution-id claim) (get-in intent [:owner :execution-id]))))
                            (not= :cancel-requested (:phase claim))
                            (nil? (:execution-cancel-in-progress durable)))]
            (when-not exact?
              (throw (ex-info "Runtime execution claim or cancellation fence was lost"
                              {:code :runtime_claim_lost
                               :execution-id (:execution-id expected)
                               :expected-generation (:cancel-generation expected)
                               :durable-generation generation})))
            (when (= :claimed (:phase claim))
              (let [executing (assoc claim :phase :executing :executing-at (store/now))
                    updated (if intent-id
                              (-> (assoc durable :runtime-claim executing)
                                  (assoc-in [:execution-intents intent-id :phase] :executing)
                                  (assoc-in [:execution-intents intent-id :owner] executing)
                                  (assoc-in [:execution-intents intent-id :consumed] true)
                                  (assoc-in [:execution-intents intent-id :executing-at] (store/now)))
                              (assoc durable :runtime-claim executing))]
                (binding [store/*allow-execution-intent-update* true]
                  (store/save-context! updated))
                (store/event-once! updated
                  {:event "runtime.executing"
                   :event_id (str (:execution-id claim) "/executing")
                   :execution_id (:execution-id claim) :intent_id intent-id :pid pid
                   :cancel_generation generation})
                (when intent-id
                  (store/event-once! updated
                    {:event "execution.intent.consumed"
                     :event_id (get-in updated [:execution-intents intent-id :consumed-event-id])
                     :intent_id intent-id :generation (:intent-generation claim)
                     :execution_id (:execution-id claim)}))))
            true))))))

(defn unregister! [run-dir pid]
  (let [path (runtime-process-path run-dir)
        current-start (process-start (java.lang.ProcessHandle/current))]
    (store/with-run-lock run-dir
      (fn []
        (let [ctx (store/load-context run-dir)
              claim (:runtime-claim ctx)]
          (when (and (= pid (:pid claim)) (= current-start (:process-started-at claim)))
            (let [intent-id (:intent-id claim)
                  finished (if intent-id
                             (-> (assoc ctx :runtime-claim nil)
                                 (assoc-in [:execution-intents intent-id :phase] :finished)
                                 (assoc-in [:execution-intents intent-id :finished-at] (store/now)))
                             (assoc ctx :runtime-claim nil))]
              (store/event-once! ctx {:event "runtime.released"
                                      :event_id (str (:execution-id claim) "/released")
                                      :execution_id (:execution-id claim) :intent_id intent-id :pid pid})
              (binding [store/*allow-execution-intent-update* true]
                (store/save-context! finished))))
          (when (and (fs/exists? path)
                     (= pid (:pid (store/read-json path)))
                     (or (= 2 (:version (store/read-json path)))
                         (= current-start (:process_started_at (store/read-json path)))))
            (fs/delete-if-exists path)))))))
(defn normalized-run-dir [run-dir] (str (fs/normalize (fs/absolutize run-dir))))
(defn owner-env [ctx] {"AGENT_RUN_DIR" (normalized-run-dir (get-in ctx [:run :dir]))})
(defn- update-child-pids! [run-dir f]
  (let [path (runtime-process-path run-dir)]
    (when (fs/exists? path)
      (let [record (store/read-json path)]
        (store/write-json! path (assoc record :child_pids (vec (f (or (:child_pids record) [])))))))))
(defn- register-child! [run-dir pid]
  (update-child-pids! run-dir #(distinct (conj % pid))))
(defn- unregister-child! [run-dir pid]
  (update-child-pids! run-dir #(remove #{pid} %)))
(defn- owning-runtime-dir [run-dir]
  (loop [candidate (fs/normalize (fs/absolutize run-dir))]
    (if (fs/exists? (runtime-process-path candidate))
      candidate
      (let [parent (fs/parent candidate)]
        (when (and parent (not= candidate parent))
          (recur parent))))))
(defn run-tracked!
  "Run a direct child and persist its PID while it is active. This is the
  cancellation fallback on platforms where ProcessHandle tree enumeration is
  denied (notably sandboxed macOS); Linux additionally discovers descendants
  through /proc ownership markers."
  [run-dir command opts]
  (let [child (process/process command opts)
        pid (.pid ^java.lang.Process (:proc child))
        owner-dir (owning-runtime-dir run-dir)]
    (when owner-dir (register-child! owner-dir pid))
    (try
      @child
      (finally
        (when owner-dir (unregister-child! owner-dir pid))))))
(defn- enumeration-denied? [error]
  (let [message (some-> error .getMessage str/lower-case)]
    (boolean (and message (some #(str/includes? message %) ["operation not permitted" "permission denied" "sysctl failed"])))))
(defn- descendants [handle]
  (try (with-open [stream (.descendants handle)] {:handles (vec (iterator-seq (.iterator stream))) :enumerated true})
       (catch RuntimeException error (if (enumeration-denied? error) {:handles [] :enumerated false} (throw error)))))
(defn- wait-until-exited [handles attempts]
  (loop [remaining attempts]
    (let [alive (filterv #(.isAlive ^java.lang.ProcessHandle %) handles)]
      (cond (empty? alive) true
            (zero? remaining) false
            :else (do (Thread/sleep 50) (recur (dec remaining)))))))
(defn- wait-until-absent [handles attempts]
  (let [pids (mapv #(.pid ^java.lang.ProcessHandle %) handles)]
    (loop [remaining attempts]
      (let [present (filterv #(.isPresent (java.lang.ProcessHandle/of (long %))) pids)]
        (cond (empty? present) true
              (zero? remaining) false
              :else (do (Thread/sleep 50) (recur (dec remaining))))))))
(defn- wait-for-exit [handles]
  (if (wait-until-exited handles 40)
    true
    (do
      (doseq [handle handles]
        (when (.isAlive ^java.lang.ProcessHandle handle)
          (.destroyForcibly ^java.lang.ProcessHandle handle)))
      (wait-until-exited handles 40))))
(defn- linux-environment [pid]
  (let [path (fs/path "/proc" (str pid) "environ")]
    (when (fs/exists? path) (try (str/split (slurp (str path)) #"\u0000") (catch Exception _ nil)))))
(defn- owned-by? [owner marker] (or (= owner marker) (str/starts-with? marker (str owner "/fragments/"))))
(defn- owned-handles [run-dir]
  (let [owner (normalized-run-dir run-dir) prefix "AGENT_RUN_DIR=" current (.pid (java.lang.ProcessHandle/current))
        owned? (fn [handle] (some #(when (str/starts-with? % prefix) (owned-by? owner (normalized-run-dir (subs % (count prefix))))) (linux-environment (.pid ^java.lang.ProcessHandle handle))))]
    (if-not (fs/exists? "/proc") {:handles [] :enumerated false}
      (with-open [stream (java.lang.ProcessHandle/allProcesses)]
        {:handles (->> (iterator-seq (.iterator stream)) (remove #(= current (.pid ^java.lang.ProcessHandle %))) (filter owned?) vec) :enumerated true}))))
(defn stop-owned! [run-dir]
  (let [{:keys [handles enumerated]} (owned-handles run-dir)]
    (doseq [handle handles] (when (.isAlive ^java.lang.ProcessHandle handle) (.destroy ^java.lang.ProcessHandle handle)))
    {:owned_processes (count handles) :owned_processes_enumerated enumerated
     :owned_processes_stopped (if (seq handles) (wait-for-exit handles) true)}))
(defn stop! [run-dir]
  (let [path (runtime-process-path run-dir)
        record (when (fs/exists? path) (store/read-json path))
        ctx (when (fs/exists? (fs/path run-dir "state.edn")) (store/load-context run-dir))
        claim (:runtime-claim ctx)
        pid (or (:pid claim) (:pid record))
        expected-start (or (:process-started-at claim) (:process_started_at record))
        strict-owner? (boolean (or claim (= 3 (:version record))))
        optional (when (and (integer? pid) (pos? pid)) (java.lang.ProcessHandle/of (long pid)))
        candidate (when (and optional (.isPresent optional)) (.get optional))
        actual-start (some-> candidate process-start)
        owner-mismatch? (boolean (and candidate strict-owner? (not= expected-start actual-start)))
        root (when (and candidate (not owner-mismatch?)) candidate)
        child-result (if (and root (.isAlive root)) (descendants root) {:handles [] :enumerated true})
        recorded-handles (keep (fn [child-pid]
                                 (let [candidate (java.lang.ProcessHandle/of (long child-pid))]
                                   (when (.isPresent candidate) (.get candidate))))
                               (:child_pids record))
        children (->> (concat recorded-handles (:handles child-result))
                      (reduce (fn [by-pid handle] (assoc by-pid (.pid ^java.lang.ProcessHandle handle) handle)) {})
                      vals vec)
        ;; Stop the durable-state writer before its children. Otherwise a
        ;; child terminated for cancellation can unblock the runtime and let
        ;; it persist a competing failure before cancel! writes "cancelled".
        root-stopped? (if (and root (.isAlive root))
                        (do (.destroyForcibly ^java.lang.ProcessHandle root)
                            (wait-for-exit [root]))
                        true)]
    (doseq [handle (reverse children)]
      (when (.isAlive ^java.lang.ProcessHandle handle)
        (.destroy ^java.lang.ProcessHandle handle)))
    (let [children-exited? (if (seq children) (wait-for-exit children) true)
          ;; ProcessHandle.isAlive becomes false as soon as a descendant exits,
          ;; including while it is briefly a zombie waiting for the runtime
          ;; root (or the OS reaper after root termination) to collect it.
          ;; Cancellation is synchronous, so do not report success until those
          ;; descendant PIDs have disappeared from the process table as well.
          children-reaped? (if (seq children) (wait-until-absent children 40) true)
          owned (stop-owned! run-dir)]
      (fs/delete-if-exists path)
      (merge {:pid pid :process_found (boolean root) :owner_mismatch owner-mismatch?
              :descendants (count children)
              :descendants_enumerated (:enumerated child-result)
              :stopped (and (not owner-mismatch?) root-stopped? children-exited? children-reaped?
                            (:owned_processes_stopped owned))} owned))))
