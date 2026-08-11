(ns tesseraft.runtime.lifecycle
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.string :as str]
            [tesseraft.runtime.fragment :as fragment]
            [tesseraft.runtime.process :as runtime-process]
            [tesseraft.runtime.store :as store]
            [tesseraft.spec :as spec]))

(defn parse-input [s]
  (let [[k v] (str/split s #"=" 2)] [(keyword k) v]))

(def terminal-run-statuses #{"done" "failed" "error" "cancelled"})

(defn terminal-run? [ctx]
  (contains? terminal-run-statuses (get-in ctx [:run :status])))

(def runtime-process-path runtime-process/runtime-process-path)
(def register-runtime-process! runtime-process/register!)
(def unregister-runtime-process! runtime-process/unregister!)
(def run-owner-env runtime-process/owner-env)
(def run-tracked-process! runtime-process/run-tracked!)
(def stop-owned-processes! runtime-process/stop-owned!)
(def stop-runtime-process! runtime-process/stop!)

(defn retry-allowed-status? [status]
  (contains? #{"failed" "cancelled"} status))

(defn- live-runtime-process? [run-dir]
  (let [path (runtime-process-path run-dir)
        record (when (fs/exists? path) (store/read-json path))
        pid (:pid record)]
    (when (and (integer? pid) (pos? pid))
      (when-let [handle (some-> (java.lang.ProcessHandle/of (long pid)) (.orElse nil))]
        (.isAlive handle)))))

(defn- current-workflow-sha [ctx]
  (let [wf-file (get-in ctx [:workflow :file])]
    (when (and wf-file (fs/exists? wf-file))
      (store/sha256 (slurp wf-file)))))

(defn- assert-pinned-workflow-readable! [ctx]
  (let [wf-file (get-in ctx [:workflow :file])
        run-dir (get-in ctx [:run :dir])]
    (when (str/blank? wf-file)
      (throw (ex-info "Pinned workflow file is missing from run context (retry_missing_workflow_file)"
                      {:run-dir run-dir :error "retry_missing_workflow_file"})))
    (when-not (fs/exists? wf-file)
      (throw (ex-info "Pinned workflow file does not exist (retry_missing_workflow_file)"
                      {:run-dir run-dir :error "retry_missing_workflow_file" :file wf-file})))
    (try
      (spec/read-workflow wf-file)
      (catch Throwable t
        (throw (ex-info "Pinned workflow file is unreadable (retry_unreadable_workflow_file)"
                        {:run-dir run-dir :error "retry_unreadable_workflow_file" :file wf-file}
                        t))))))

(defn- pinned-workflow-sha [ctx]
  (when-let [version (get-in ctx [:workflow :version])]
    (when (string? version)
      (second (str/split version #":" 2)))))

(defn read-run-events [ctx]
  (let [p (fs/path (get-in ctx [:run :dir]) "events.jsonl")]
    (when (fs/exists? p)
      (->> (str/split-lines (slurp (str p)))
           (remove str/blank?)
           (keep #(try (json/parse-string % true) (catch Throwable _ nil)))
           vec))))

(defn last-terminal-evidence [ctx]
  (let [events (read-run-events ctx)]
    (last (filter #(contains? #{"node.failed" "node.orphaned" "run.max-rounds-exceeded" "run.cancelled"} (:event %)) events))))

(defn retry! [run-dir {:keys [reason repin]}]
  (let [ctx (store/load-context run-dir)
        status (get-in ctx [:run :status])]
    ;; Single-writer guard comes first: a live runtime-process.json marker
    ;; means an executing runner owns this run dir, regardless of whether the
    ;; persisted status is running, failed, or cancelled. Recovery must never
    ;; race an executing runner.
    (when (live-runtime-process? run-dir)
      (throw (ex-info "Run cannot be retried while owned by a live process (retry_live_process)"
                      {:run-dir run-dir :error "retry_live_process"})))
    (when-not (retry-allowed-status? status)
      (throw (ex-info "Run cannot be retried because it is not in a failed or cancelled state (retry_requires_failed_or_cancelled)"
                      {:run-dir run-dir :status status :error "retry_requires_failed_or_cancelled"})))
    (assert-pinned-workflow-readable! ctx)
    (let [current-sha (current-workflow-sha ctx)
          pinned-sha (pinned-workflow-sha ctx)
          pinned-version (get-in ctx [:workflow :version])]
      (when (and (not repin) current-sha pinned-sha (not= pinned-sha current-sha))
        (throw (ex-info "Workflow content changed since this run was pinned (retry_pin_mismatch)"
                        {:run-dir run-dir
                         :error "retry_pin_mismatch"
                         :pinned pinned-version
                         :current (str "sha256:" current-sha)})))
      (let [prior-attempt (get-in ctx [:run :attempt])
            new-attempt (inc prior-attempt)
            prior-state (get-in ctx [:run :state])
            running (-> ctx
                        (assoc-in [:run :status] "running")
                        (assoc-in [:run :attempt] new-attempt)
                        (assoc-in [:run :updated-at] (store/now)))
            repin-data (when (and repin pinned-sha current-sha (not= pinned-sha current-sha))
                         {:old_hash pinned-sha :new_hash current-sha})
            prior-evidence (last-terminal-evidence ctx)]
        (store/save-context! running)
        (store/event! running (cond-> {:event "run.recovery"
                                         :prior_status status
                                         :prior_state (some-> prior-state name)
                                         :prior_attempt prior-attempt
                                         :new_attempt new-attempt
                                         :reason reason
                                         :repin repin-data
                                         :at (store/now)}
                                  prior-evidence (assoc :prior_evidence prior-evidence)))
        running))))

(defn cancel! [run-dir]
  (let [before (store/load-context run-dir)]
    (if (terminal-run? before)
      before
      (let [process (stop-runtime-process! run-dir)
            ;; Reload after stopping the process so its last durable transition
            ;; cannot overwrite the cancellation state.
            ctx (store/load-context run-dir)
            cancelled (-> ctx
                          (assoc-in [:run :status] "cancelled")
                          (assoc-in [:run :updated-at] (store/now)))]
        (store/event! cancelled {:event "run.cancelled"
                                 :pid (:pid process)
                                 :process_found (:process_found process)
                                 :descendants (:descendants process)
                                 :descendants_enumerated (:descendants_enumerated process)
                                 :owned_processes (:owned_processes process)
                                 :owned_processes_enumerated (:owned_processes_enumerated process)
                                 :owned_processes_stopped (:owned_processes_stopped process)
                                 :stopped (:stopped process)})
        (store/save-context! cancelled)
        ;; A fragment's own nested run dir is a full durable run in its own
        ;; right: cancelling the parent must not leave it silently "running"
        ;; forever once the owning parent process is gone. The parent's own
        ;; "cancelled" status is already durable above, so a throw while
        ;; cancelling a nested run (e.g. an unreadable state.edn) can never
        ;; leave the parent's own cancellation unrecorded; cancel-internal-runs!
        ;; itself isolates failures per nested attempt dir.
        (fragment/cancel-internal-runs! cancelled)
        cancelled))))

(defn default-branch [inputs]
  (when-let [item-id (or (:item-id inputs) (:work-item-id inputs))]
    (str "feature/" (str/lower-case item-id))))

(defn init-context [wf opts]
  (let [content (slurp (spec/workflow-file wf))
        run-id (or (:run-id opts)
                   (str "run-" (-> (store/now) (str/replace #"[:.]" "-") (str/replace #"Z$" "Z"))))
        name (spec/workflow-name wf)
        run-dir (str (fs/absolutize (fs/path (or (:workspace-root opts) ".")
                                      (or (:runs-root opts) ".agent-runs")
                                      name run-id)))
        inputs (merge {:repo-root "."
                       :base-branch (get-in wf [:defaults :base-branch] "main")}
                      (:inputs opts))
        inputs (if (:branch inputs) inputs (assoc inputs :branch (default-branch inputs)))
        git-user-name (some-> (get-in opts [:git-user :name]) str/trim not-empty)
        git-user-email (some-> (get-in opts [:git-user :email]) str/trim not-empty)
        git-user (when (and git-user-name git-user-email)
                   {:name git-user-name :email git-user-email})
        executor-mode (when-let [executor (:executor opts)] (clojure.core/name executor))
        project-id (or (:project-id opts) "default")
        runtime-options (select-keys opts [:workspace-root :tesseraft-home :runs-root :workflow-roots :project-context])]
    {:workflow {:name name
                :file (spec/workflow-file wf)
                :version (str "sha256:" (store/sha256 content))
                :defaults (:defaults wf {})}
     :inputs inputs
     :run (cond-> {:id run-id
                  :dir run-dir
                  :project-id project-id
                  :state (:initial wf)
                  :status "running"
                  :round 1
                  :attempt 1
           :feedback-cycle 1
           :issues-file (str (fs/path run-dir "issues.json"))
           :created-at (store/now)
           :updated-at (store/now)}
         executor-mode (assoc :executor-mode executor-mode)
         git-user (assoc :git-user git-user)
         (seq runtime-options) (merge runtime-options))}))
