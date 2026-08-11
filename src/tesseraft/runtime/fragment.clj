(ns tesseraft.runtime.fragment
  "Runtime execution boundary for {:type :fragment} nodes: pin resolution,
  isolated internal context, and terminal-outcome mapping. Internal
  deterministic/router/terminal execution is reused from
  tesseraft.runtime.core (run-until-done!/step!) over a workflow-like view of
  the resolved package; this namespace never runs a node itself."
  (:require
    [tesseraft.lint.core :as lint]
    [tesseraft.spec :as spec]
    [tesseraft.runtime.store :as store]
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.string :as str]))

(def supported-internal-node-types #{:agent :process :timer :deterministic :router :terminal})

(defn- diagnostics-blocking? [diagnostics]
  (some #(= "error" (:severity %)) diagnostics))

(defn- render-bound-value [parent-ctx v]
  (if (string? v) (spec/render-template-string v parent-ctx) v))

(defn- render-effective-bindings [parent-ctx m]
  (into {} (map (fn [[k v]] [k (render-bound-value parent-ctx v)])) (or m {})))

(defn resolve-inclusion!
  "Re-resolve and re-validate the fragment boundary for this node against the
  live package on disk (the pin check happens per execution, not once at
  parent lint time), rendering bound inputs/parameters against the parent
  context. Throws ex-info {:error-type \"fragment_unresolved\" ...} carrying
  the lint diagnostics for any missing/mismatched/unbound/invalid inclusion."
  [wf parent-ctx state-id node]
  (let [result (lint/fragment-node-result wf state-id node {})
        diagnostics (:diagnostics result)]
    (when (or (diagnostics-blocking? diagnostics) (nil? (:inclusion result)))
      (throw (ex-info "Fragment inclusion could not be resolved"
                      {:error-type "fragment_unresolved"
                       :state (name state-id)
                       :fragment (:fragment node)
                       :diagnostics diagnostics})))
    (let [inclusion (:inclusion result)
          pkg (spec/read-fragment-package (:package-path inclusion))
          rendered (-> inclusion
                       (update :inputs #(render-effective-bindings parent-ctx %))
                       (update :parameters #(render-effective-bindings parent-ctx %)))]
      {:inclusion rendered :pkg pkg})))

(defn assert-supported-internal-nodes!
  "Reject a reachable internal node type this runtime cannot execute
  (approval, nested fragment) before any internal state runs."
  [state-id pkg]
  (let [fragment (:fragment pkg)
        states (:states fragment {})
        wf-like {:initial (:initial fragment) :states states}
        reachable (spec/reachable-states wf-like)
        unsupported (vec (for [id reachable
                               :let [n (get states id)]
                               :when (and (map? n) (not (contains? supported-internal-node-types (:type n))))]
                           {:state (name id) :type (:type n)}))]
    (when (seq unsupported)
      (throw (ex-info "Fragment package references an unsupported internal node type"
                      {:error-type "fragment_unsupported_node"
                       :state (name state-id)
                       :fragment (spec/fragment-package-name pkg)
                       :unsupported unsupported})))))

(defn effective-max-rounds [pkg inclusion]
  (let [param (get-in inclusion [:parameters :max-rounds])]
    (if (integer? param) param (get-in pkg [:fragment :defaults :max-rounds]))))

(defn internal-workflow
  "A workflow-like view of the resolved package's internal subgraph, reusing
  run-until-done!/step! verbatim. :defaults/:max-rounds is the effective
  max-rounds parameter when the interface declares one, else the package's
  own fragment-local default."
  [pkg inclusion]
  (let [fragment (:fragment pkg)
        max-rounds (effective-max-rounds pkg inclusion)]
    {:initial (:initial fragment)
     :defaults (cond-> (:defaults fragment {}) max-rounds (assoc :max-rounds max-rounds))
     :policies (:policies fragment)
     :states (:states fragment)
     :__dir (spec/fragment-package-dir pkg)
     :__file (spec/fragment-package-file pkg)}))

(defn internal-run-dir [parent-ctx state-id attempt]
  (str (fs/path (get-in parent-ctx [:run :dir]) "fragments" (name state-id) (str attempt))))

(defn- event-mirror-descriptor
  "Data-only descriptor threaded through the internal ctx so
  tesseraft.runtime.store/event! can mirror every internal event into the
  parent's own log as it happens. Plain strings/ints, so it survives
  save-context!'s dissoc of :credential-resolver and reloads unchanged."
  [parent-ctx state-id attempt pkg]
  {:parent-dir (get-in parent-ctx [:run :dir])
   :state (name state-id)
   :attempt attempt
   :fragment (spec/fragment-package-name pkg)})

(defn internal-context
  "An isolated internal run context nested under the parent run directory.
  Inputs are the effective inputs merged under effective parameters (bound
  values win on name collision). Only project id, executor mode, runtime
  options, and redaction configuration are inherited from the parent; rounds,
  attempts, issues, and artifacts all start fresh. Carries an :event-mirror
  descriptor from creation so every internal event (not just fragment.started/
  fragment.finished) is durably visible in the parent's own log as it happens."
  [parent-ctx state-id attempt pkg internal-wf inclusion]
  (let [run-dir (internal-run-dir parent-ctx state-id attempt)
        inputs (merge (:inputs inclusion) (:parameters inclusion))
        runtime-options (select-keys (:run parent-ctx) [:workspace-root :tesseraft-home :runs-root :workflow-roots :project-context])
        run-map (cond-> (merge {:id (str (name state-id) "-" attempt)
                                :dir run-dir
                                :project-id (get-in parent-ctx [:run :project-id])
                                :state (:initial internal-wf)
                                :status "running"
                                :round 1
                                :attempt 1
                                :feedback-cycle 1
                                :issues-file (str (fs/path run-dir "issues.json"))
                                :created-at (store/now)
                                :updated-at (store/now)}
                               runtime-options)
                        (get-in parent-ctx [:run :executor-mode]) (assoc :executor-mode (get-in parent-ctx [:run :executor-mode])))]
    (cond-> {:workflow {:name (spec/fragment-package-name pkg)
                        :file (spec/fragment-package-file pkg)
                        :version (str "sha256:" (store/sha256 (slurp (spec/fragment-package-file pkg))))
                        :defaults (:defaults internal-wf)}
             :inputs inputs
             :run run-map
             :event-mirror (event-mirror-descriptor parent-ctx state-id attempt pkg)}
      (contains? parent-ctx :credential-resolver) (assoc :credential-resolver (:credential-resolver parent-ctx))
      (contains? parent-ctx :credential-secrets) (assoc :credential-secrets (:credential-secrets parent-ctx))
      (contains? parent-ctx :skip-project-credential-redaction?) (assoc :skip-project-credential-redaction? (:skip-project-credential-redaction? parent-ctx)))))

(defn durable-internal-run?
  "True when a nested run dir for this state+attempt already has a persisted
  state.edn -- either a still-running boundary a prior process was killed
  inside of, or one that reached its own terminal status before the parent
  ever recorded finishing the fragment step."
  [parent-ctx state-id attempt]
  (fs/exists? (fs/path (internal-run-dir parent-ctx state-id attempt) "state.edn")))

(def ^:private internal-terminal-statuses #{"done" "failed" "error" "cancelled"})

(defn terminal-internal-run?
  "True when the (already-reloaded) internal ctx's own run status is
  terminal, i.e. the nested subgraph itself finished even if the parent never
  got to see it (finish! may still not have run)."
  [internal-ctx]
  (contains? internal-terminal-statuses (get-in internal-ctx [:run :status])))

(defn resume-internal-context
  "Reload a durable nested run's persisted state.edn and re-attach the
  live-only fields save-context! strips (:credential-resolver) or that the
  parent owns and may have changed since the original pin! (:credential-
  secrets, :skip-project-credential-redaction?, runtime options, executor
  mode), plus a freshly rebuilt :event-mirror descriptor."
  [parent-ctx state-id attempt pkg]
  (let [dir (internal-run-dir parent-ctx state-id attempt)
        reloaded (store/load-context dir)
        owned-run-keys (select-keys (:run parent-ctx)
                                    [:workspace-root :tesseraft-home :runs-root
                                     :workflow-roots :project-context :executor-mode])]
    (cond-> (update reloaded :run merge owned-run-keys)
      (contains? parent-ctx :credential-resolver) (assoc :credential-resolver (:credential-resolver parent-ctx))
      (contains? parent-ctx :credential-secrets) (assoc :credential-secrets (:credential-secrets parent-ctx))
      (contains? parent-ctx :skip-project-credential-redaction?) (assoc :skip-project-credential-redaction? (:skip-project-credential-redaction? parent-ctx))
      true (assoc :event-mirror (event-mirror-descriptor parent-ctx state-id attempt pkg)))))

(defn verify-pin!
  "Refuse to resume a nested run whose pinned package content hash no longer
  matches the package currently on disk: continuing to execute the internal
  subgraph against a package that has since been edited (states/transitions
  changed) could silently corrupt a nested run in flight, rather than merely
  changing what a fresh inclusion would do."
  [state-id pkg inclusion internal-ctx]
  (let [pin-path (fs/path (get-in internal-ctx [:run :dir]) "pin.json")
        pin (store/read-json pin-path)
        current-sha (store/sha256 (slurp (:package-path inclusion)))]
    (when (not= (:package_sha256 pin) current-sha)
      (throw (ex-info "Fragment package changed since this internal run was pinned"
                      {:error-type "fragment_pin_changed"
                       :state (name state-id)
                       :fragment (spec/fragment-package-name pkg)
                       :pinned_sha256 (:package_sha256 pin)
                       :current_sha256 current-sha})))))

(defn resumed!
  "Parent-level evidence that a durable nested run is continuing from its
  persisted boundary rather than restarting: not itself mirrored (it is
  already a parent-native event), unlike the internal node.*/transition.*
  events store/event! mirrors as the nested loop advances."
  [parent-ctx state-id attempt pkg internal-ctx]
  (store/event! parent-ctx {:event "fragment.resumed"
                            :state (name state-id)
                            :attempt attempt
                            :fragment (spec/fragment-package-name pkg)
                            :internal_dir (get-in internal-ctx [:run :dir])
                            :internal_state (some-> (get-in internal-ctx [:run :state]) name)
                            :internal_status (get-in internal-ctx [:run :status])}))

(defn- internal-run-attempt-dirs
  "Every fragments/<state>/<attempt> dir under the parent run that has a
  persisted state.edn, regardless of that run's own status."
  [parent-ctx]
  (let [root (fs/path (get-in parent-ctx [:run :dir]) "fragments")]
    (if-not (fs/exists? root)
      []
      (vec (for [state-dir (fs/list-dir root)
                :when (fs/directory? state-dir)
                attempt-dir (fs/list-dir state-dir)
                :when (and (fs/directory? attempt-dir)
                           (fs/exists? (fs/path attempt-dir "state.edn")))]
            attempt-dir)))))

(defn cancel-internal-runs!
  "Mark every still-running nested fragment run cancelled. Each nested ctx
  already carries its own persisted :event-mirror descriptor (set at
  creation), so appending run.cancelled through store/event! on it mirrors a
  fragment.run.cancelled into the parent log the same way any other internal
  event would be, with no extra wiring here. Each attempt dir is cancelled
  independently: a throw reading or writing one dir's state (e.g. an
  unreadable/truncated state.edn) must not stop the remaining nested runs
  from being cancelled, and the caller has already durably recorded the
  parent's own cancellation before calling this."
  [parent-ctx]
  (doseq [dir (internal-run-attempt-dirs parent-ctx)]
    (try
      (let [ctx (store/load-context dir)]
        (when-not (contains? internal-terminal-statuses (get-in ctx [:run :status]))
          (let [cancelled (-> ctx
                              (assoc-in [:run :status] "cancelled")
                              (assoc-in [:run :updated-at] (store/now)))]
            (store/event! cancelled {:event "run.cancelled"})
            (store/save-context! cancelled))))
      (catch Throwable t
        (binding [*out* *err*]
          (println "cancel-internal-runs!: failed to cancel nested run" (str dir) "-" (.getMessage t)))))))

(defn pin!
  "Write nested pin.json evidence (identity, scope, version, package content
  sha256, bindings) and a parent fragment.started event."
  [parent-ctx state-id attempt pkg inclusion internal-ctx]
  (let [pin-path (fs/path (get-in internal-ctx [:run :dir]) "pin.json")
        package-sha (store/sha256 (slurp (:package-path inclusion)))
        pin-data {:record_version 1
                  :fragment (spec/fragment-package-name pkg)
                  :scope (spec/outcome-name (:scope inclusion))
                  :version (:version inclusion)
                  :package_path (:package-path inclusion)
                  :package_sha256 package-sha
                  :prefix (:prefix inclusion)
                  :bindings {:inputs (:inputs inclusion) :parameters (:parameters inclusion)}}]
    (store/write-runtime-json! internal-ctx pin-path pin-data)
    (store/event! parent-ctx {:event "fragment.started"
                              :state (name state-id)
                              :attempt attempt
                              :fragment (spec/fragment-package-name pkg)
                              :scope (:scope pin-data)
                              :version (:version inclusion)
                              :package_sha256 package-sha
                              :internal_dir (get-in internal-ctx [:run :dir])})
    pin-data))

(defn- read-events [run-dir]
  (let [p (fs/path run-dir "events.jsonl")]
    (when (fs/exists? p)
      (->> (str/split-lines (slurp (str p)))
           (remove str/blank?)
           (keep #(try (json/parse-string % true) (catch Throwable _ nil)))
           vec))))

(def ^:private nested-failure-event-types #{"run.max-rounds-exceeded" "node.failed" "node.orphaned"})

(defn- nested-failure-error-type [internal-ctx]
  (let [events (read-events (get-in internal-ctx [:run :dir]))
        last-relevant (last (filter #(contains? nested-failure-event-types (:event %)) events))]
    (if (= "run.max-rounds-exceeded" (:event last-relevant))
      "fragment_max_rounds"
      "fragment_internal_failure")))

(defn- terminal-outcome [internal-wf internal-ctx]
  (let [state-id (get-in internal-ctx [:run :state])]
    (:outcome (get-in internal-wf [:states state-id]))))

(defn- exit-produces
  "The reached exit entry's normalized :produces map (output-key -> nested
  run-dir-relative path), matching lint's own normalized-output-key-map so
  the same key ends up naming the same output on both sides."
  [pkg outcome-str]
  (let [entry (first (filter #(= (spec/outcome-name (:on %)) outcome-str) (get-in pkg [:fragment :exit])))]
    (lint/normalized-output-key-map (:produces entry))))

(defn- required-exit-output-keys [pkg]
  (set (for [[k contract] (get-in pkg [:interface :outputs] {})
            :when (lint/fragment-node-output-required? contract)]
        (lint/normalize-fragment-name-key k))))

(defn- exit-index-path [parent-ctx]
  (str (fs/path (get-in parent-ctx [:run :dir]) "fragments" "exit-index.json")))

(defn- read-exit-index
  "Read the exit-index with string keys throughout (both the destination-path
  keys and the owner-map keys): store/read-json keywordizes keys, which would
  turn a `/`-bearing destination path into a namespaced keyword and never
  match the plain string dest-rel this namespace looks it up by."
  [parent-ctx]
  (let [p (exit-index-path parent-ctx)]
    (if (fs/exists? p) (json/parse-string (slurp (str p)) false) {})))

(defn materialize-exit-outputs!
  "Copy every path the reached exit entry :produces from the nested run dir
  into the parent run dir at the inclusion's declared :prefix (a blank prefix
  projects onto the identical relative path, matching lint's
  prefix-resource-path so the two never disagree). A :produces value that
  fails spec/safe-relative-path? raises fragment_exit_output_invalid_path
  before anything is read or copied, so a package predating the matching
  fragment-interface-checks lint rule still cannot read from above the
  nested run dir or write above the parent run dir. A key required by
  :interface :outputs whose file the nested run never wrote raises
  fragment_exit_output_missing before anything is copied. A destination path
  already owned by a different parent inclusion state, or that already
  exists in the parent run dir with no recorded owner at all, raises
  fragment_exit_output_conflict before anything is copied; the same state
  re-materializing (a retry) is not a conflict. Ownership is recorded before
  the copies run, so a kill between the two leaves the index already
  attributing the destination to this state: re-entry sees an owner match,
  not a conflict, and re-copies. Returns a map of output name to the
  parent-relative path actually written."
  [parent-ctx state-id pkg inclusion internal-dir outcome-str]
  (let [produces (exit-produces pkg outcome-str)
        required (required-exit-output-keys pkg)
        prefix (:prefix inclusion)
        fragment-name (spec/fragment-package-name pkg)
        state-name (name state-id)]
    (doseq [[output-key rel-path] produces
            :when (not (spec/safe-relative-path? rel-path))]
      (throw (ex-info "Fragment exit produces an unsafe path"
                      {:error-type "fragment_exit_output_invalid_path"
                       :state state-name
                       :fragment fragment-name
                       :output (name output-key)
                       :path rel-path})))
    (let [entries (for [[output-key rel-path] produces]
                    {:output output-key
                     :src (str (fs/path internal-dir rel-path))
                     :dest-rel (lint/prefix-resource-path prefix rel-path)
                     :required? (contains? required output-key)})]
      (doseq [{:keys [output src required?]} entries
              :when (and required? (not (fs/exists? src)))]
        (throw (ex-info "Fragment exit did not produce a required output"
                        {:error-type "fragment_exit_output_missing"
                         :state state-name
                         :fragment fragment-name
                         :output (name output)})))
      (let [existing (filter #(fs/exists? (:src %)) entries)
            index (read-exit-index parent-ctx)]
        (doseq [{:keys [dest-rel output]} existing
                :let [owner (get index dest-rel)
                      dest (str (fs/path (get-in parent-ctx [:run :dir]) dest-rel))]]
          (cond
            (and owner (not= (get owner "state") state-name))
            (throw (ex-info "Fragment exit output path is already owned by another inclusion"
                            {:error-type "fragment_exit_output_conflict"
                             :state state-name
                             :fragment fragment-name
                             :output (name output)
                             :path dest-rel
                             :owner_state (get owner "state")
                             :owner_fragment (get owner "fragment")}))

            (and (nil? owner) (fs/exists? dest))
            (throw (ex-info "Fragment exit output path already exists outside any recorded fragment ownership"
                            {:error-type "fragment_exit_output_conflict"
                             :state state-name
                             :fragment fragment-name
                             :output (name output)
                             :path dest-rel
                             :owner_state nil
                             :owner_fragment nil}))))
        (when (seq existing)
          (store/write-json! (exit-index-path parent-ctx)
                             (reduce (fn [idx {:keys [dest-rel]}]
                                       (assoc idx dest-rel {:state state-name :fragment fragment-name}))
                                     index existing)))
        (doseq [{:keys [src dest-rel]} existing
                :let [dest (str (fs/path (get-in parent-ctx [:run :dir]) dest-rel))]]
          (fs/create-dirs (fs/parent dest))
          (fs/copy src dest {:replace-existing true}))
        (into {} (map (fn [{:keys [output dest-rel]}] [(name output) dest-rel])) existing)))))

(defn finish!
  "Map the nested run's outcome onto the parent :fragment/outcome result, or
  raise one classified failure (fragment_max_rounds, fragment_internal_failure,
  fragment_outcome_unrouted, fragment_exit_output_missing,
  fragment_exit_output_conflict). Materializes the reached exit entry's
  declared outputs into the parent run dir and appends a parent
  fragment.finished event on success."
  [parent-ctx state-id attempt node pkg inclusion internal-wf internal-ctx]
  (let [status (get-in internal-ctx [:run :status])
        internal-dir (get-in internal-ctx [:run :dir])
        rounds (get-in internal-ctx [:run :round])
        finished-state (some-> (get-in internal-ctx [:run :state]) name)]
    (cond
      (= "done" status)
      (let [outcome (terminal-outcome internal-wf internal-ctx)
            outcome-str (spec/outcome-name outcome)
            result {:status "ok" :ok true
                    :fragment/outcome outcome-str
                    :outcome outcome-str
                    :fragment (spec/fragment-package-name pkg)
                    :internal_state finished-state
                    :internal_rounds rounds
                    :internal_dir internal-dir}]
        ;; Routability is decided by the exact same predicate
        ;; (spec/match-transition?) over a result the returned one only
        ;; extends (:exit_outputs is assoc'd on below, after this check);
        ;; match-transition? reads only keys named by a transition's :when,
        ;; so adding a key is monotone and can neither un-match nor promote
        ;; the transition choose-transition later selects for this result.
        (when (or (nil? outcome)
                  (not (some #(spec/match-transition? result %) (spec/transitions node))))
          (throw (ex-info "Fragment outcome is not routed by any parent transition"
                          {:error-type "fragment_outcome_unrouted"
                           :state (name state-id)
                           :fragment (spec/fragment-package-name pkg)
                           :outcome outcome-str})))
        (let [exit-outputs (materialize-exit-outputs! parent-ctx state-id pkg inclusion internal-dir outcome-str)
              result (cond-> result (seq exit-outputs) (assoc :exit_outputs exit-outputs))]
          (store/event! parent-ctx {:event "fragment.finished"
                                    :state (name state-id)
                                    :attempt attempt
                                    :fragment (spec/fragment-package-name pkg)
                                    :outcome outcome-str
                                    :internal_state finished-state
                                    :internal_rounds rounds
                                    :internal_dir internal-dir
                                    :exit_outputs exit-outputs})
          result))

      (= "failed" status)
      (throw (ex-info "Fragment internal execution failed"
                      {:error-type (nested-failure-error-type internal-ctx)
                       :state (name state-id)
                       :fragment (spec/fragment-package-name pkg)
                       :internal_state finished-state
                       :internal_rounds rounds
                       :internal_dir internal-dir}))

      :else
      (throw (ex-info "Fragment internal execution did not complete within the fragment step budget"
                      {:error-type "fragment_internal_failure"
                       :state (name state-id)
                       :fragment (spec/fragment-package-name pkg)
                       :internal_state finished-state
                       :internal_status status
                       :internal_rounds rounds
                       :internal_dir internal-dir})))))
