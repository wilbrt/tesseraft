(ns tesseraft.runtime.process
  (:require [babashka.fs :as fs]
            [babashka.process :as process]
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
              {:keys [exact-live]} (when existing (claim-owner existing))]
          (when (and exact-live (not (and (= pid (:pid existing))
                                          (= started (:process-started-at existing)))))
            (throw (ex-info "Run is already owned by a live runtime execution"
                            {:code :runtime_claim_conflict :owner (:execution-id existing)})))
          (if (and exact-live (= pid (:pid existing)) (= started (:process-started-at existing)))
            pid
            (let [claim {:version 1 :execution-id execution-id :pid pid
                         :process-started-at started :phase :claimed :claimed-at (store/now)}
                  claimed (assoc ctx :runtime-claim claim)]
              (store/save-context! claimed)
              (store/write-json! (runtime-process-path run-dir)
                                 {:version 3 :execution_id execution-id :pid pid
                                  :process_started_at started :child_pids [] :started_at (store/now)})
              (store/event-once! claimed {:event "runtime.claimed" :event_id (str execution-id "/claimed")
                                          :execution_id execution-id :pid pid})
              pid)))))))

(defn unregister! [run-dir pid]
  (let [path (runtime-process-path run-dir)
        current-start (process-start (java.lang.ProcessHandle/current))]
    (store/with-run-lock run-dir
      (fn []
        (let [ctx (store/load-context run-dir)
              claim (:runtime-claim ctx)]
          (when (and (= pid (:pid claim)) (= current-start (:process-started-at claim)))
            (store/event-once! ctx {:event "runtime.released"
                                    :event_id (str (:execution-id claim) "/released")
                                    :execution_id (:execution-id claim) :pid pid})
            (store/save-context! (assoc ctx :runtime-claim nil)))
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
