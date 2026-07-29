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

(defn internal-context
  "An isolated internal run context nested under the parent run directory.
  Inputs are the effective inputs merged under effective parameters (bound
  values win on name collision). Only project id, executor mode, runtime
  options, and redaction configuration are inherited from the parent; rounds,
  attempts, issues, and artifacts all start fresh."
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
             :run run-map}
      (contains? parent-ctx :credential-resolver) (assoc :credential-resolver (:credential-resolver parent-ctx))
      (contains? parent-ctx :credential-secrets) (assoc :credential-secrets (:credential-secrets parent-ctx))
      (contains? parent-ctx :skip-project-credential-redaction?) (assoc :skip-project-credential-redaction? (:skip-project-credential-redaction? parent-ctx)))))

(defn pin!
  "Write nested pin.json evidence (identity, scope, version, package content
  sha256, bindings) and a parent fragment.started event."
  [parent-ctx state-id attempt pkg inclusion internal-ctx]
  (let [pin-path (fs/path (get-in internal-ctx [:run :dir]) "pin.json")
        package-sha (store/sha256 (slurp (:package-path inclusion)))
        pin-data {:fragment (spec/fragment-package-name pkg)
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
  prefix-resource-path so the two never disagree). A key required by
  :interface :outputs whose file the nested run never wrote raises
  fragment_exit_output_missing before anything is copied. A destination path
  already owned by a different parent inclusion state raises
  fragment_exit_output_conflict before anything is copied; the same state
  re-materializing (a retry) is not a conflict. Returns a map of output name
  to the parent-relative path actually written."
  [parent-ctx state-id pkg inclusion internal-dir outcome-str]
  (let [produces (exit-produces pkg outcome-str)
        required (required-exit-output-keys pkg)
        prefix (:prefix inclusion)
        fragment-name (spec/fragment-package-name pkg)
        state-name (name state-id)
        entries (for [[output-key rel-path] produces]
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
              :let [owner (get index dest-rel)]]
        (when (and owner (not= (get owner "state") state-name))
          (throw (ex-info "Fragment exit output path is already owned by another inclusion"
                          {:error-type "fragment_exit_output_conflict"
                           :state state-name
                           :fragment fragment-name
                           :output (name output)
                           :path dest-rel
                           :owner_state (get owner "state")
                           :owner_fragment (get owner "fragment")}))))
      (doseq [{:keys [src dest-rel]} existing
              :let [dest (str (fs/path (get-in parent-ctx [:run :dir]) dest-rel))]]
        (fs/create-dirs (fs/parent dest))
        (fs/copy src dest {:replace-existing true}))
      (when (seq existing)
        (store/write-json! (exit-index-path parent-ctx)
                           (reduce (fn [idx {:keys [dest-rel]}]
                                     (assoc idx dest-rel {:state state-name :fragment fragment-name}))
                                   index existing)))
      (into {} (map (fn [{:keys [output dest-rel]}] [(name output) dest-rel])) existing))))

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
        ;; (spec/match-transition?) over the exact result finish! is about to
        ;; return, so this can never diverge from the transition
        ;; choose-transition later selects for this same result.
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
