(ns tesseraft.control-plane.core
  (:require
    [tesseraft.lint.core :as lint]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.string :as str]))

(def default-options
  {:workspace-root "."
   :workflow-roots ["examples"]
   :tesseraft-home nil
   :runs-root ".agent-runs"})

(defn opts [options]
  (merge default-options options))

(defn api-value [x]
  (cond
    (keyword? x) (name x)
    (map? x) (into {} (map (fn [[k v]] [(if (keyword? k) (name k) (str k)) (api-value v)])) x)
    (vector? x) (mapv api-value x)
    (seq? x) (mapv api-value x)
    (set? x) (mapv api-value x)
    :else x))

(defn error-response
  ([status code message] (error-response status code message {}))
  ([status code message details]
   {:status status
    :error {:code code :message message :details (api-value details)}}))

(defn abs-path [workspace-root p]
  (let [path (fs/path p)]
    (if (fs/absolute? path)
      (fs/normalize path)
      (fs/normalize (fs/path workspace-root path)))))

(defn path-prefix? [parent child]
  (let [parent* (str (fs/normalize parent))
        child* (str (fs/normalize child))]
    (or (= parent* child*)
        (str/starts-with? child* (str parent* java.io.File/separator)))))

(defn relative-path [workspace-root p]
  (try
    (let [root (abs-path workspace-root ".")
          path (abs-path workspace-root p)]
      (if (path-prefix? root path)
        (str (fs/relativize root path))
        (str path)))
    (catch Throwable _
      (str p))))

(defn tesseraft-home [options]
  (or (:tesseraft-home (opts options))
      (System/getenv "TESSERAFT_HOME")
      (str (fs/path (System/getProperty "user.home") ".tesseraft"))))

(defn discovery-roots [options kind]
  (let [{:keys [workspace-root workflow-roots]} (opts options)
        root-name (name kind)]
    (vec
      (concat
        (map-indexed
          (fn [idx root]
            {:root (abs-path workspace-root root)
             :source :configured
             :precedence idx})
          workflow-roots)
        [{:root (fs/path (tesseraft-home options) root-name)
          :source :global
          :precedence 100}
         {:root (abs-path workspace-root (fs/path ".tesseraft" root-name))
          :source :project
          :precedence 200}]))))

(defn package-files [options kind file-name]
  (->> (discovery-roots options kind)
       (mapcat (fn [{:keys [root source precedence]}]
                 (when (fs/exists? root)
                   (for [p (file-seq (fs/file root))
                         :when (and (.isFile p) (= file-name (.getName p)))]
                     {:file (fs/path p)
                      :source source
                      :precedence precedence}))))
       (remove nil?)
       (sort-by (juxt :precedence (comp str :file)))
       vec))

(defn workflow-files [options]
  (mapv :file (package-files options :workflows "workflow.edn")))

(defn workflow-file-entries [options]
  (package-files options :workflows "workflow.edn"))

;; Fragment packages live under .tesseraft/fragments/<name>/fragment.edn,
;; ~/.tesseraft/fragments/<name>/fragment.edn, and
;; examples/fragments/<name>/fragment.edn, using the same generic
;; discovery-roots/package-files helpers.
(defn fragment-file-entries [options]
  (package-files options :fragments "fragment.edn"))

(defn fragment-files [options]
  (mapv :file (fragment-file-entries options)))

(defn fragment-candidates [options name]
  (->> (fragment-file-entries options)
       (keep (fn [p]
               (try
                 (let [pkg (spec/read-fragment-package (:file p))]
                   (when (= (str name) (str (spec/fragment-package-name pkg)))
                     {:file (:file p)
                      :source (:source p)
                      :precedence (:precedence p)
                      :fragment pkg}))
                 (catch Throwable _ nil))))
       vec))

(defn resolve-fragment [options name]
  (let [matches (fragment-candidates options name)
        max-precedence (when (seq matches) (apply max (map :precedence matches)))
        visible-matches (filter #(= max-precedence (:precedence %)) matches)]
    (cond
      (empty? visible-matches) (error-response 404 "not_found" "Fragment package not found" {:name name})
      (> (count visible-matches) 1) (error-response 409 "conflict" "Multiple fragment packages share this name"
                                                    {:name name :paths (mapv #(relative-path (:workspace-root (opts options)) (:file %)) visible-matches)})
      :else (first visible-matches))))

(defn lint-summary [lint-result]
  {:ok (:ok lint-result)
   :errors (count (:errors lint-result))
   :warnings (count (:warnings lint-result))})

(defn read-workflow-entry [options workflow-entry]
  (let [{:keys [workspace-root]} (opts options)
        workflow-file (if (map? workflow-entry) (:file workflow-entry) workflow-entry)
        source (if (map? workflow-entry) (:source workflow-entry) :configured)
        precedence (when (map? workflow-entry) (:precedence workflow-entry))
        lint-result (lint/lint-file workflow-file)]
    (try
      (let [wf (spec/read-workflow workflow-file)]
        (cond-> {:name (str (spec/workflow-name wf))
                 :path (relative-path workspace-root workflow-file)
                 :source source
                 :api_version (:api-version wf)
                 :lint (lint-summary lint-result)}
          (some? precedence) (assoc :precedence precedence)))
      (catch Throwable t
        (cond-> {:name nil
                 :path (relative-path workspace-root workflow-file)
                 :source source
                 :api_version nil
                 :lint (lint-summary lint-result)
                 :error {:code "parse_error" :message (.getMessage t)}}
          (some? precedence) (assoc :precedence precedence))))))

(defn entry-name [entry]
  (try
    (str (spec/workflow-name (spec/read-workflow (:file entry))))
    (catch Throwable _ nil)))

(defn select-visible-workflow-entries [entries]
  (->> entries
       (group-by entry-name)
       (mapcat (fn [[name same-name]]
                 (if (nil? name)
                   same-name
                   (let [max-precedence (apply max (map :precedence same-name))]
                     (filter #(= max-precedence (:precedence %)) same-name)))))
       (sort-by (juxt (comp str entry-name) (comp str :file)))
       vec))

(defn workflow-meta-item
  "Compact, UI-facing record of a same-name workflow entry used to describe
  shadowing/conflict relationships. `scope` is the stringified discovery source
  (configured/global/project); kept distinct from the outer entry's `source`
  field name to match the design contract (outer keeps `source`, shadowing
  lists use `scope`)."
  [workspace-root entry]
  {:scope (name (:source entry))
   :path (relative-path workspace-root (:file entry))
   :precedence (:precedence entry)})

(defn shadowing-for-visible
  "Compute purely-inspectable shadowing metadata for each *visible* workflow
  entry without altering precedence/selection semantics. For a visible entry
  `v` with name `n` and precedence `p`:
    - `conflicts`   = other same-name entries at equal precedence `p`
                     (the ambiguous case resolve-workflow 409s on; surfaced
                     here so the list endpoint can show *why* without a resolve).
    - `duplicates`  = other same-name entries at strictly lower precedence
                     (entries this one overrides/shadows).
  Returns a map from the entry's file path (string) to its metadata.
  Grouping reuses `entry-name` (the same reader the unchanged
  `select-visible-workflow-entries` uses), so the visible set is exactly what
  `select-visible-workflow-entries` already returns — nothing about precedence
  selection changes here."
  [options entries visible]
  (let [{:keys [workspace-root]} (opts options)
        by-name (group-by entry-name entries)]
    (into {}
      (for [v visible
            :let [name (entry-name v)
                  same-name (get by-name name)
                  self-file (:file v)
                  prec (:precedence v)
                  others (remove #(= (:file %) self-file) same-name)
                  conflicts (mapv #(workflow-meta-item workspace-root %)
                                  (filter #(= (:precedence %) prec) others))
                  duplicates (mapv #(workflow-meta-item workspace-root %)
                                   (filter #(< (:precedence %) prec) others))]]
        [(str self-file)
         (cond-> {:precedence prec}
           (seq conflicts) (assoc :conflicts conflicts)
           (seq duplicates) (assoc :duplicates duplicates))]))))

(defn list-workflows
  ([] (list-workflows {}))
  ([options]
   (let [entries (workflow-file-entries options)
         visible (select-visible-workflow-entries entries)
         meta (shadowing-for-visible options entries visible)]
     {:workflows (mapv (fn [v]
                         (api-value
                           (merge (read-workflow-entry options v)
                                  (get meta (str (:file v))))))
                       visible)})))

(defn workflow-candidates [options name]
  (->> (workflow-file-entries options)
       (keep (fn [p]
               (try
                 (let [wf (spec/read-workflow (:file p))]
                   (when (= (str name) (str (spec/workflow-name wf)))
                     {:file (:file p)
                      :source (:source p)
                      :precedence (:precedence p)
                      :workflow wf}))
                 (catch Throwable _ nil))))
       vec))

(defn resolve-workflow [options name]
  (let [matches (workflow-candidates options name)
        max-precedence (when (seq matches) (apply max (map :precedence matches)))
        visible-matches (filter #(= max-precedence (:precedence %)) matches)]
    (cond
      (empty? visible-matches) (error-response 404 "not_found" "Workflow not found" {:name name})
      (> (count visible-matches) 1) (error-response 409 "conflict" "Multiple workflows share this name"
                                                    {:name name :paths (mapv #(relative-path (:workspace-root (opts options)) (:file %)) visible-matches)})
      :else (first visible-matches))))

(defn get-workflow
  ([] (get-workflow {} nil))
  ([options name]
   (let [resolved (resolve-workflow options name)]
     (if (:error resolved)
       resolved
       (let [{:keys [workspace-root]} (opts options)
             {:keys [file workflow source precedence]} resolved
             lint-result (lint/lint-file file)
             ;; Shadowing context for the detail view. `resolve-workflow`
             ;; already 409s on an equal-precedence conflict, so when we
             ;; get here the resolution is unique: `conflicts` is therefore
             ;; empty in practice (kept for symmetry with the list endpoint)
             ;; and `duplicates` lists the lower-precedence same-name entries
             ;; this workflow overrides. Precedence/selection semantics are
             ;; untouched — this only attaches inspection metadata.
             matches (workflow-candidates options name)
             others (remove #(= (:file %) file) matches)
             conflicts (mapv #(workflow-meta-item workspace-root %)
                             (filter #(= (:precedence %) precedence) others))
             duplicates (mapv #(workflow-meta-item workspace-root %)
                              (filter #(< (:precedence %) precedence) others))]
         (api-value
           (cond-> {:workflow {:name (str (spec/workflow-name workflow))
                               :path (relative-path workspace-root file)
                               :source source
                               :precedence precedence
                               :api_version (:api-version workflow)
                               :normalized (dissoc workflow :__file :__dir)
                               :lint lint-result}}
             (seq conflicts) (assoc-in [:workflow :conflicts] conflicts)
             (seq duplicates) (assoc-in [:workflow :duplicates] duplicates))))))))

(defn edge-from-transition [from tr]
  (cond-> {:from (spec/normalize-id from)
           :to (spec/normalize-id (:next tr))}
    (:when tr) (assoc :condition (:when tr))
    (:effects tr) (assoc :effects (:effects tr))))

(defn get-workflow-graph
  ([] (get-workflow-graph {} nil))
  ([options name]
   (let [resolved (resolve-workflow options name)]
     (if (:error resolved)
       resolved
       (let [{:keys [file workflow]} resolved
             lint-result (lint/lint-file file)]
         (api-value
           {:workflow_name (str (spec/workflow-name workflow))
            :nodes (vec (for [[id node] (:states workflow)]
                          (cond-> {:id (spec/normalize-id id)
                                   :type (:type node)}
                            (:title node) (assoc :title (:title node))
                            (:outputs node) (assoc :outputs (:outputs node))
                            (:resources node) (assoc :resources (:resources node)))))
            :edges (vec (for [[from node] (:states workflow)
                              tr (spec/transitions node)
                              :when (:next tr)]
                          (edge-from-transition from tr)))
            :diagnostics (:diagnostics lint-result)}))))))

(defn run-state-files [options]
  (let [{:keys [workspace-root runs-root]} (opts options)
        root (abs-path workspace-root runs-root)]
    (if-not (fs/exists? root)
      []
      (->> (for [p (file-seq (fs/file root))
                 :when (and (.isFile p) (= "state.edn" (.getName p)))]
             (fs/path p))
           (sort-by str)
           vec))))

(defn run-dir-from-state-file [state-file]
  (fs/parent state-file))

(defn staleness-threshold-seconds
  "Configurable staleness threshold (seconds). Default 120s. Override with the
  TESSERAFT_STALE_THRESHOLD_SECONDS environment variable. Kept out of CLI
  arg parsing to avoid breaking existing callers."
  []
  (or (some-> (System/getenv "TESSERAFT_STALE_THRESHOLD_SECONDS")
              (parse-long)
              (#(when (and % (pos? %)) %)))
      120))

(defn ^:private parse-instant
  ^java.time.Instant [s]
  (when (and s (string? s))
    (try (java.time.Instant/parse s) (catch Throwable _ nil))))

(defn seconds-since
  "Whole seconds between an ISO-8601 timestamp and now, or nil if unparseable."
  [s]
  (when-let [t (parse-instant s)]
    (.getSeconds (java.time.Duration/between t (java.time.Instant/now)))))

(defn latest-event-at
  "Return the :at timestamp of the last event in the append-only events list, or
  nil when there are no events. Events are written by the runtime on every
  transition (node.started/finished/failed/orphaned, transition.selected,
  effect.applied, run.*) with an :at timestamp, so the newest event is a fresh
  heartbeat of run activity independent of state.edn's :updated-at (which is
  only bumped on transitions, not while a subprocess is executing)."
  [events]
  (when (seq events)
    (:at (last events))))

(defn- newest-timestamp
  "Given a collection of ISO-8601 timestamp strings, return the one that
  parses to the latest java.time.Instant (the original string is preserved so
  downstream string-consuming helpers like seconds-since still work). Returns
  nil if none parse."
  [ts]
  (let [pairs (keep (fn [s] (when-let [i (parse-instant s)] [i s])) ts)]
    (when (seq pairs)
      (->> pairs
           (reduce (fn [[best-i best-s] [i s]]
                     (if (or (nil? best-i) (.isAfter i best-i)) [i s] [best-i best-s]))
                   [nil nil])
           second))))

(defn derive-liveness
  "Additive, read-only heuristic liveness for a run. Returns a map with
  :liveness (one of done/failed/orphaned/stale/executing/parked) and
  :staleness_seconds. attempts may be empty for a cheap derivation; an empty
  attempts seq means we cannot see an in-flight node, so a fresh running run is
  reported as parked and a stale one as stale (acceptable for the Runs list).
  The full get-run path supplies real attempts so orphaned/executing are
  distinguished.

  Optional :last-activity-at (an ISO-8601 timestamp) overrides/augments the
  summary's :updated_at for staleness. The detail path (get-run/delete-run)
  passes max(:updated_at, latest-event-at) here so a long-running node that is
  actively emitting events is not marked stale/orphaned merely because
  state.edn's :updated-at (bumped only on node transitions) is older than the
  threshold. This preserves the fail-fast orphan intent: a wedged node stops
  emitting events and still trips the threshold → orphaned."
  ([summary attempts] (derive-liveness summary attempts nil))
  ([summary attempts opts]
   (let [status (:status summary)
         state-name (when (:state summary) (name (:state summary)))
         non-terminal (not (#{"done" "failed" "error"} (str status)))
         last-activity (:last-activity-at opts)
         activity-ts (when non-terminal
                      (if last-activity
                        (or (newest-timestamp [(:updated_at summary) last-activity])
                            (:updated_at summary))
                        (:updated_at summary)))
         staleness-s (when non-terminal (seconds-since activity-ts))
         threshold (staleness-threshold-seconds)
         stale? (and staleness-s (>= staleness-s threshold))
         current-running (when (and non-terminal state-name (seq attempts))
                          (->> attempts
                               (filter #(and (= state-name (str (:state %)))
                                             (= "running" (:status %))))
                               first))]
     {:liveness
      (cond
        (= "done" (str status)) "done"
        (#{"failed" "error"} (str status)) "failed"
        current-running (if stale? "orphaned" "executing")
        stale? "stale"
        :else "parked")
      :staleness_seconds staleness-s})))

(defn run-summary [options state-file]
  (let [{:keys [workspace-root]} (opts options)
        ctx (store/load-context (run-dir-from-state-file state-file))
        run (:run ctx)
        workflow (:workflow ctx)
        summary {:run_id (or (:id run) (str (fs/file-name (run-dir-from-state-file state-file))))
                 :workflow_name (:name workflow)
                 :workflow_version (:version workflow)
                 :state (:state run)
                 :status (:status run)
                 :round (:round run)
                 :attempt (:attempt run)
                 :created_at (:created-at run)
                 :updated_at (:updated-at run)
                 :path (relative-path workspace-root (run-dir-from-state-file state-file))}
        ;; Cheap liveness for the Runs list: no attempts are derived here
        ;; (derive-attempts-from-events is defined later in this namespace and
        ;; babashka resolves defn-body symbols eagerly, so a forward reference
        ;; would fail). Empty attempts yields done/failed/stale/parked, which is
        ;; enough to surface dead/stale runs in the list (ISSUE 4). The detail
        ;; endpoint get-run recomputes liveness with real attempts to add
        ;; orphaned/executing.
        liveness (derive-liveness summary [])]
    (merge summary liveness)))

(defn list-runs
  ([] (list-runs {}))
  ([options]
   (let [entries (mapv (fn [state-file]
                         (try
                           {:run (api-value (run-summary options state-file))}
                           (catch Throwable t
                             {:error {:code "parse_error"
                                      :message (.getMessage t)
                                      :details {:path (relative-path (:workspace-root (opts options)) state-file)}}})))
                       (run-state-files options))]
     {:runs (mapv :run (filter :run entries))
      :errors (mapv :error (filter :error entries))})))

(defn matching-run-files [options run-id]
  (->> (run-state-files options)
       (keep (fn [state-file]
               (try
                 (let [ctx (store/load-context (run-dir-from-state-file state-file))
                       recorded-id (get-in ctx [:run :id])
                       dir-id (str (fs/file-name (run-dir-from-state-file state-file)))]
                   (when (or (= (str run-id) (str recorded-id)) (= (str run-id) dir-id))
                     {:state-file state-file :run-dir (run-dir-from-state-file state-file) :context ctx}))
                 (catch Throwable _ nil))))
       vec))

(defn resolve-run [options run-id]
  (let [matches (matching-run-files options run-id)]
    (cond
      (empty? matches) (error-response 404 "not_found" "Run not found" {:run_id run-id})
      (> (count matches) 1) (error-response 409 "conflict" "Multiple runs share this run id"
                                            {:run_id run-id
                                             :paths (mapv #(relative-path (:workspace-root (opts options)) (:run-dir %)) matches)})
      :else (first matches))))

(defn events-file [run-dir]
  (fs/path run-dir "events.jsonl"))

(defn read-events-file [p]
  (if-not (fs/exists? p)
    []
    (let [lines (str/split-lines (slurp (str p)))]
      (loop [idx 1 xs lines acc []]
        (if-let [line (first xs)]
          (if (str/blank? line)
            (recur (inc idx) (rest xs) acc)
            (let [parsed (try
                           (json/parse-string line true)
                           (catch Throwable t
                             (reduced (error-response 422 "parse_error" "Malformed event JSONL line"
                                                      {:line idx :message (.getMessage t)}))))]
              (if (reduced? parsed)
                @parsed
                (recur (inc idx) (rest xs) (conj acc parsed)))))
          acc)))))

(defn event-name [event]
  (or (:event event) (:type event)))

(defn nonzero-exit-code? [result]
  (let [exit-code (:exit-code result)]
    (and (number? exit-code) (not (zero? exit-code)))))

(defn result-error? [result]
  (and result
       (or (= "error" (:status result))
           (= false (:ok result))
           (nonzero-exit-code? result))))

(defn result-error-summary [result]
  (when (result-error? result)
    (or (:message result)
        (:error result)
        (:stderr result)
        (when (nonzero-exit-code? result) (str "exit code " (:exit-code result)))
        (when (= "error" (:status result)) "result status error"))))

(defn attempt-status [finished? result]
  (cond
    (result-error? result) "error"
    finished? "ok"
    :else "running"))

(defn derive-attempts-from-events [events]
  (loop [events events active {} acc []]
    (if-let [event (first events)]
      (let [name (event-name event)]
        (case name
          "node.started"
          (let [attempt (or (:attempt event) (inc (count acc)))
                state (:state event)]
            (recur (rest events)
                   (assoc active state {:attempt attempt
                                        :node_id state
                                        :state state
                                        :started_at (:at event)
                                        :status "running"})
                   acc))
          "node.finished"
          (let [state (:state event)
                current (or (get active state) {:attempt (inc (count acc)) :node_id state :state state})
                result (:result event)
                attempt (assoc current
                               :finished_at (:at event)
                               :status (attempt-status true result)
                               :result result)
                attempt (cond-> attempt
                          (result-error-summary result) (assoc :error (result-error-summary result)))]
            (recur (rest events) (dissoc active state) (conj acc attempt)))
          "node.failed"
          (let [state (:state event)
                current (or (get active state) {:attempt (or (:attempt event) (inc (count acc))) :node_id state :state state})
                result (:result event)
                attempt (cond-> (assoc current
                                       :finished_at (:at event)
                                       :status "error"
                                       :result result)
                          (or (:error event) (result-error-summary result))
                          (assoc :error (or (:error event) (result-error-summary result))))]
            (recur (rest events) (dissoc active state) (conj acc attempt)))
          "node.orphaned"
          (let [state (:state event)
                current (or (get active state) {:attempt (or (:attempt event) (inc (count acc))) :node_id state :state state})
                attempt (cond-> (assoc current
                                       :finished_at (:at event)
                                       :status "error"
                                       :result (:result event))
                          (or (:error event) "orphaned")
                          (assoc :error (or (:error event) "orphaned")))]
            (recur (rest events) (dissoc active state) (conj acc attempt)))
          "transition.selected"
          (let [from (:from event)]
            (recur (rest events)
                   active
                   (mapv (fn [attempt]
                           (if (= (:state attempt) from)
                             (assoc attempt :next_state (:to event) :effects (:effects event))
                             attempt)) acc)))
          (recur (rest events) active acc)))
      (vec (concat acc (vals active))))))

(defn attempts-from-context [ctx events]
  (let [explicit (or (:attempts ctx) (get-in ctx [:run :attempts]))]
    (if (seq explicit)
      explicit
      (derive-attempts-from-events events))))

(def preview-limit (* 64 1024))
(def scan-file-limit 250)
(def max-read-size (* 1024 1024))

(defn reject-artifact-path [p]
  (cond
    (str/blank? (str p)) (error-response 400 "bad_request" "Artifact path is required")
    (fs/absolute? (fs/path p)) (error-response 403 "forbidden" "Absolute artifact paths are not readable")
    (some #{".."} (str/split (str p) #"/")) (error-response 403 "forbidden" "Parent path traversal is not allowed")
    :else nil))

(defn path-starts-with? [child parent]
  (.startsWith (.normalize child) (.normalize parent)))

(defn safe-artifact-path [run-dir rel-path]
  (if-let [err (reject-artifact-path rel-path)]
    err
    (let [base (.toRealPath (.toPath (fs/file run-dir)) (make-array java.nio.file.LinkOption 0))
          candidate (.normalize (.resolve base (str rel-path)))]
      (if-not (path-starts-with? candidate base)
        (error-response 403 "forbidden" "Artifact path escapes the run directory")
        {:path candidate :base base :rel (str rel-path)}))))

(defn existing-safe-file [run-dir rel-path]
  (let [resolved (safe-artifact-path run-dir rel-path)]
    (if (:error resolved)
      resolved
      (let [p (:path resolved)]
        (cond
          (not (java.nio.file.Files/exists p (make-array java.nio.file.LinkOption 0)))
          (assoc resolved :exists false)
          (java.nio.file.Files/isDirectory p (make-array java.nio.file.LinkOption 0))
          (error-response 400 "bad_request" "Artifact path is a directory")
          :else
          (let [real (.toRealPath p (make-array java.nio.file.LinkOption 0))]
            (if-not (path-starts-with? real (:base resolved))
              (error-response 403 "forbidden" "Artifact symlink escapes the run directory")
              (assoc resolved :path real :exists true))))))))

(defn rel-from-run [run-dir p]
  (str (fs/relativize (fs/path run-dir) (fs/path p))))

(defn content-type [path]
  (case (str/lower-case (or (fs/extension (str path)) ""))
    "json" "application/json"
    "jsonl" "application/x-jsonlines"
    "edn" "application/edn"
    "md" "text/markdown"
    "txt" "text/plain"
    "log" "text/plain"
    "text/plain"))

(defn previewable? [artifact]
  (and (:exists artifact)
       (<= (or (:size artifact) 0) preview-limit)
       (#{"application/json" "application/x-jsonlines" "application/edn" "text/markdown" "text/plain"} (:content_type artifact))))

(defn artifact-meta [run-dir rel-path source extra]
  (let [safe (safe-artifact-path run-dir rel-path)
        p (:path safe)
        exists (and (not (:error safe)) (java.nio.file.Files/exists p (make-array java.nio.file.LinkOption 0)))
        file? (and exists (not (java.nio.file.Files/isDirectory p (make-array java.nio.file.LinkOption 0))))
        real (when file? (try (.toRealPath p (make-array java.nio.file.LinkOption 0)) (catch Throwable _ nil)))
        escaped? (and real (not (path-starts-with? real (:base safe))))]
    (merge {:path (str rel-path)
            :name (str (fs/file-name (fs/path rel-path)))
            :source source
            :exists (and file? (not escaped?))
            :size (when (and file? (not escaped?)) (java.nio.file.Files/size real))
            :modified_at (when (and file? (not escaped?)) (str (java.nio.file.Files/getLastModifiedTime real (make-array java.nio.file.LinkOption 0))))
            :content_type (content-type rel-path)
            :read_url (str "?path=" (java.net.URLEncoder/encode (str rel-path) "UTF-8"))}
           extra)))

(defn declared-output-artifacts [ctx run-dir]
  (try
    (let [wf (spec/read-workflow (get-in ctx [:workflow :file]))]
      (vec (for [[state-id node] (:states wf)
                 [out-key out-path] (spec/outputs-with-paths node)
                 :let [rendered (spec/render-template-string out-path ctx)]
                 :when (and rendered (not (str/blank? rendered)) (not (fs/absolute? (fs/path rendered))))]
             (artifact-meta run-dir rendered "declared_output"
                            {:node_id (spec/normalize-id state-id) :kind (name out-key)}))))
    (catch Throwable _ [])))

(def artifact-key-regex #"(?i)(^|[-_])(file|path|artifact|log)([-_]|$)")

(defn artifact-path-values [x]
  (cond
    (map? x) (mapcat (fn [[k v]]
                       (cond
                         (and (string? v) (re-find artifact-key-regex (name k))) [v]
                         (or (map? v) (sequential? v)) (artifact-path-values v)
                         :else [])) x)
    (sequential? x) (mapcat artifact-path-values x)
    :else []))

(defn run-relative-string [run-dir s]
  (let [s (str s)
        run-dir-str (str (fs/normalize run-dir))]
    (cond
      (str/starts-with? s run-dir-str) (rel-from-run run-dir s)
      (not (fs/absolute? (fs/path s))) s
      :else nil)))

(defn event-artifacts [events run-dir]
  (->> events
       (mapcat (fn [event]
                 (for [p (artifact-path-values event)
                       :let [rel (run-relative-string run-dir p)]
                       :when (and rel (not (reject-artifact-path rel)))]
                   (artifact-meta run-dir rel "event"
                                  {:node_id (or (:state event) (:from event))
                                   :attempt (:attempt event)}))))
       vec))

(defn scan-artifacts [run-dir]
  (let [roots ["state.edn" "events.jsonl" "issues.json" "logs" "prompts/generated" "attempts"]]
    (->> roots
         (mapcat (fn [root]
                   (let [p (fs/path run-dir root)]
                     (when (fs/exists? p)
                       (if (fs/directory? p)
                         (take scan-file-limit (filter #(.isFile %) (file-seq (fs/file p))))
                         [p])))))
         (remove nil?)
         (take scan-file-limit)
         (mapv #(artifact-meta run-dir (rel-from-run run-dir %) "run_dir" {})))))

(defn dedupe-artifacts [artifacts]
  (->> artifacts
       (group-by :path)
       (mapv (fn [[_ xs]] (apply merge xs)))
       (sort-by :path)
       vec))

(defn list-artifacts* [ctx run-dir events]
  (dedupe-artifacts (concat (declared-output-artifacts ctx run-dir)
                            (event-artifacts events run-dir)
                            (scan-artifacts run-dir))))

(defn get-run-artifacts
  ([] (get-run-artifacts {} nil))
  ([options run-id]
   (let [resolved (resolve-run options run-id)]
     (if (:error resolved)
       resolved
       (let [events (read-events-file (events-file (:run-dir resolved)))]
         (if (:error events)
           events
           (api-value {:run_id run-id :artifacts (list-artifacts* (:context resolved) (:run-dir resolved) events)})))))))

(defn read-run-artifact
  ([] (read-run-artifact {} nil nil))
  ([options run-id artifact-path]
   (let [resolved (resolve-run options run-id)]
     (if (:error resolved)
       resolved
       (let [safe (existing-safe-file (:run-dir resolved) artifact-path)]
         (cond
           (:error safe) safe
           (not (:exists safe)) (error-response 404 "not_found" "Artifact not found" {:path artifact-path})
           :else (let [meta (artifact-meta (:run-dir resolved) artifact-path "read" {})
                       size (:size meta)]
                   (cond
                     (> size max-read-size) (api-value {:artifact meta :previewable false :reason "file too large"})
                     (not (previewable? meta)) (api-value {:artifact meta :previewable false :reason "binary or unsupported content type"})
                     :else (api-value {:artifact meta :previewable true :content (slurp (str (:path safe)))})))))))))

(defn issues-artifact-has-issues?
  "True if the issues JSON artifact at `rel-path` under `run-dir` actually
  contains issues, false otherwise. The initial issues.json is an empty array
  `[]` written at run start by runtime.store/ensure-run-dirs!; its existence
  therefore does NOT indicate a problem during a healthy run. Only flag a failure
  here when the parsed content indicates real issues: a non-empty sequence, or a
  map whose :issues (or top-level) field is a non-empty sequence. Empty arrays,
  empty maps, null/missing, unparseable, or oversized files are NOT failures.
  Bounded by max-read-size to avoid reading huge artifacts in this hot path."
  [run-dir rel-path]
  (when (and run-dir rel-path (not (str/blank? (str rel-path))))
    (try
      (let [safe (existing-safe-file run-dir rel-path)]
        (when (and (not (:error safe)) (:exists safe))
          ;; existing-safe-file already rejects directories/traversal/symlink
          ;; escapes; reuse its path resolution and existence check.
          (let [p (:path safe)]
            (when (and p (<= (java.nio.file.Files/size p) max-read-size))
              (let [content (try
                             (json/parse-string (slurp (str p)) true)
                             (catch Throwable _ ::unparseable))]
                (boolean
                  (cond
                    (= content ::unparseable) false
                    (nil? content) false
                    (map? content)
                    (let [issues (or (:issues content) (:items content) (:list content))]
                      (and (sequential? issues) (seq issues)))
                    (sequential? content) (seq content)
                    :else (some? content))))))))
      (catch Throwable _ false))))

(defn failures-from-run [summary attempts artifacts run-dir]
  (vec (concat
         (when (#{"failed" "error"} (:status summary)) [{:source "run" :message (str "Run status: " (:status summary))}])
         (for [attempt attempts :when (#{"failed" "error"} (:status attempt))]
           {:source "attempt" :node_id (:node_id attempt) :message (or (:error attempt) "Attempt failed")})
         (for [artifact artifacts
               :when (and (:exists artifact) (re-find #"(?i)issues.*\.json$" (:path artifact)))
               :when (issues-artifact-has-issues? run-dir (:path artifact))]
           {:source "artifact" :path (:path artifact) :message "Issues artifact present"}))))

(defn get-run
  ([] (get-run {} nil))
  ([options run-id]
   (let [resolved (resolve-run options run-id)]
     (if (:error resolved)
       resolved
       (let [{:keys [context state-file run-dir]} resolved
             summary (run-summary options state-file)
             run-id (:run_id summary)
             events (read-events-file (events-file run-dir))
             attempts (if (:error events) [] (attempts-from-context context events))
             artifacts (if (:error events) [] (list-artifacts* context run-dir events))
             ;; Heart-aware liveness: use the newest event :at as a fresh
             ;; activity signal in addition to state.edn's :updated_at, so a
             ;; node that is actively executing (emitting events) is not
             ;; wrongly marked stale/orphaned merely because :updated_at is
             ;; only bumped on node transitions. (DESIGN Change 2)
             last-activity (when-not (:error events) (latest-event-at events))
             live (derive-liveness summary attempts (when last-activity {:last-activity-at last-activity}))]
         (api-value
           {:run (-> summary
                     (assoc :liveness (:liveness live)
                            :staleness_seconds (:staleness_seconds live)
                            :attempts attempts
                            :failures (failures-from-run summary attempts artifacts run-dir)
                            :links {:events (str "/runs/" run-id "/events")
                                    :artifacts (str "/runs/" run-id "/artifacts")}))}))))))

(defn get-run-events
  ([] (get-run-events {} nil))
  ([options run-id]
   (let [resolved (resolve-run options run-id)]
     (if (:error resolved)
       resolved
       (let [events (read-events-file (events-file (:run-dir resolved)))]
         (if (:error events)
           events
           (api-value {:run_id run-id :events events :continuation nil})))))))

(defn delete-run
  "Delete a run directory. Refuses to delete a run whose recomputed liveness is
  `executing` (returns 409 conflict). Only deletes the run directory returned by
  `resolve-run`, which is confined to the configured `runs-root` tree, so there
  is no arbitrary-path delete surface."
  ([] (delete-run {} nil))
  ([options run-id]
   (let [resolved (resolve-run options run-id)]
     (if (:error resolved)
       resolved
       (let [{:keys [state-file run-dir context]} resolved
             summary (run-summary options state-file)
             events (read-events-file (events-file run-dir))
             attempts (if (:error events) [] (attempts-from-context context events))
             last-activity (when-not (:error events) (latest-event-at events))
             live (derive-liveness summary attempts (when last-activity {:last-activity-at last-activity}))]
         (if (= "executing" (:liveness live))
           (error-response 409 "conflict" "Run is still executing"
                           {:run_id run-id :liveness (:liveness live)})
           (do
             (fs/delete-tree run-dir)
             {:status 200
              :run_id run-id
              :deleted true
              :liveness (:liveness live)
              :path (relative-path (:workspace-root (opts options)) run-dir)})))))))

;; ---- approvals (manual-input :approval pause/resume) ----
;; Run-relative read surfaces for the manual-input node feature. The runtime
;; writes approvals/<state>-<attempt>.json (request) and
;; approvals/<state>-<attempt>-decision.json (decision) under the run dir; the
;; decision is recorded by `tesseraft runtime decide`. These functions expose
;; them read-only and also support run-relative artifact *comments*
;; (comments/<safe-path>.json arrays). Comments are workflow-behavior-free
;; metadata reconstructed from files (design §4).

(defn approvals-dir [run-dir] (fs/path run-dir "approvals"))

(defn comments-file [run-dir artifact-path]
  (let [rel (str artifact-path)
        err (reject-artifact-path rel)]
    (if err err
        (let [safe (fs/path "comments" (str (fs/path rel)))]
          ;; stable, traversal-safe single-file per artifact (e.g.
          ;; "comments/design/design.md.json").
          (fs/path run-dir (str safe) ".json")))))

(defn load-approval-summary [run-dir]
  (let [dir (approvals-dir run-dir)]
    (when (fs/exists? dir)
      ;; Collect pending approval-request records. A request file is named
      ;; <state>-<attempt>.json; its decision is <state>-<attempt>-decision.json.
      (let [files (for [f (file-seq (fs/file dir))
                        :when (and (.isFile f)
                                   (str/ends-with? (.getName f) ".json")
                                   (not (str/includes? (.getName f) "-decision.json")))]
                    f)]
        (->> files
             (keep (fn [f]
                     (try (store/read-json (fs/path f)) (catch Throwable _ nil))))
             (mapv #(api-value %)))))))

(defn load-approval [run-dir approval-id]
  ;; load-approval-summary returns api-value'd maps (string keys).
  (let [summaries (or (load-approval-summary run-dir) [])
        match (some #(when (= (str approval-id) (str (get % "approval_id"))) %)
                    summaries)]
    (if-not match
      (error-response 404 "not_found" "Approval not found" {:approval_id approval-id})
      ;; Enrich: look up the decision record if present.
      (let [dec-path (fs/path (approvals-dir run-dir) (str approval-id "-decision.json"))
            decision (when (fs/exists? dec-path) (store/read-json dec-path))]
        {:approval (cond-> match
                      decision (assoc "decision" (api-value decision)))}))))

(defn get-run-approvals
  ([] (get-run-approvals {} nil))
  ([options run-id]
   (let [resolved (resolve-run options run-id)]
     (if (:error resolved)
       resolved
       (api-value {:run_id run-id :approvals (or (load-approval-summary (:run-dir resolved)) [])})))))

(defn get-run-approval
  ([] (get-run-approval {} nil nil))
  ([options run-id approval-id]
   (let [resolved (resolve-run options run-id)]
     (if (:error resolved)
       resolved
       (let [result (load-approval (:run-dir resolved) approval-id)]
         (if (:error result) result (api-value result)))))))

(defn get-run-comments
  ([] (get-run-comments {} nil nil))
  ([options run-id]
   (let [resolved (resolve-run options run-id)]
     (if (:error resolved)
       resolved
       (let [artifact-path (or (some-> options :query :path) "")
             cf (comments-file (:run-dir resolved) artifact-path)
             comments (when (and (not (:error cf)) (fs/exists? cf)) (store/read-json cf))]
         (api-value {:run_id run-id :path artifact-path
                     :comments (mapv api-value (or comments []))}))))))

(defn timestamp [] (str (java.time.Instant/now)))
(defn random-id [] (str "c" (System/nanoTime)))

(defn add-run-comment
  ([] (add-run-comment {} nil nil nil))
  ([options run-id body]
   (let [{:keys [run-id-in-body]} (opts options)
         body (or body {})]
     (let [resolved (resolve-run options (or run-id run-id-in-body))]
       (if (:error resolved)
         resolved
         (let [artifact-path (or (get body :path) (get body "path"))
               anchor (or (get body :anchor) (get body "anchor"))
               text (or (get body :body) (get body "body"))]
           (cond
             (or (nil? artifact-path) (str/blank? (str artifact-path)))
             (error-response 400 "bad_request" "path is required")
             (or (nil? text) (str/blank? (str text)))
             (error-response 400 "bad_request" "body is required")
             :else
             (let [cf (comments-file (:run-dir resolved) artifact-path)]
               (if (:error cf) cf
                 (let [existing (if (fs/exists? cf) (store/read-json cf) [])
                       new-c {:id (random-id)
                              :path (str artifact-path)
                              :anchor (when (map? anchor) anchor)
                              :body (str text)
                              :author (or (get body :author) (get body "author"))
                              :created_at (timestamp)}
                       merged (conj (vec existing) new-c)]
                   (store/write-json! cf merged)
                   (api-value {:run_id run-id :comment (api-value new-c)})))))))))))

(comment
  ;; git-user config is also consumed by the runtime handlers in
  ;; tesseraft.adapters.builtin via -c user.name/user.email overrides.
  )

;; ---- git user config (source of truth: .tesseraft/git-user.json) ----
;; Defined here (after tesseraft-home) so sci analysis can resolve the
;; forward reference to tesseraft-home, which discovery-roots also uses.

(defn git-user-paths [options]
  (let [{:keys [workspace-root]} (opts options)
        home (tesseraft-home options)]
    {:project (fs/path workspace-root ".tesseraft" "git-user.json")
     :global (fs/path home "git-user.json")}))

(defn read-git-user-file [p]
  (when (fs/exists? p)
    (try (store/read-json p) (catch Throwable _ nil))))

(defn validate-git-user [name email]
  (cond
    (not (string? name)) "name must be a string"
    (str/blank? (str/trim name)) "name must not be empty"
    (> (count name) 200) "name must be at most 200 characters"
    (re-find #"\n" name) "name must not contain newlines"
    (not (string? email)) "email must be a string"
    (str/blank? (str/trim email)) "email must not be empty"
    (re-find #"[\s]" email) "email must not contain whitespace"
    (not (re-matches #"^[^@]+@[^@]+\.[^@]+$" email)) "email is not a valid address"
    :else nil))

(defn get-git-user
  ([] (get-git-user {}))
  ([options]
   (let [{:keys [project global]} (git-user-paths options)
         project-user (read-git-user-file project)
         global-user (read-git-user-file global)]
     (cond
       project-user {:git_user (assoc project-user :source "project")}
       global-user {:git_user (assoc global-user :source "global")}
       :else {:git_user {:name nil :email nil :source "none"}}))))

(defn set-git-user [options name email global?]
  (if-let [err (validate-git-user name email)]
    (error-response 400 "bad_request" err)
    (let [paths (git-user-paths options)
          target (if global? (:global paths) (:project paths))]
      (fs/create-dirs (fs/parent target))
      (store/write-json! target {:name name :email email})
      (get-git-user options))))

;; ---- settings config (source of truth: .tesseraft/settings.json) ----
;; Mirrors git-user precedence (project then global). Tokens are returned
;; masked so the browser DOM never holds the full secret; the file itself is
;; plaintext (local-only, no auth model) under the already-gitignored
;; .tesseraft/ directory.

(def ^:private settings-fields
  [:pi_default_provider :pi_default_model :github_token
   :jira_token :default_repo_root])

(def ^:private settings-token-fields
  #{:github_token :jira_token})

(def ^:private settings-length-limits
  {:pi_default_provider 100 :pi_default_model 200
   :github_token 500 :jira_token 500 :default_repo_root 1000})

;; Sentinel for "leave this token field as-is" (used by the web API to round-trip
;; masked tokens safely). See docs in `set-settings`.
(def settings-unchanged "__unchanged__")

(defn settings-paths [options]
  (let [{:keys [workspace-root]} (opts options)
        home (tesseraft-home options)]
    {:project (fs/path workspace-root ".tesseraft" "settings.json")
     :global (fs/path home "settings.json")}))

(defn read-settings-file [p]
  (when (fs/exists? p)
    (try (store/read-json p) (catch Throwable _ nil))))

(defn coerce-settings
  "Keep only the known settings fields from a parsed config map. Unknown
  fields are dropped (ignored on read)."
  [raw]
  (if (map? raw)
    (into {} (for [k settings-fields :when (contains? raw k)] [k (get raw k)]))
    {}))

(defn validate-settings-field [k v]
  (cond
    (nil? v) nil ;; not provided; nothing to validate
    (not (string? v)) (str (name k) " must be a string")
    (str/blank? (str/trim v)) (str (name k) " must not be empty")
    (re-find #"\n" v) (str (name k) " must not contain newlines")
    :else
    (let [limit (get settings-length-limits k)]
      (if (and limit (> (count v) limit))
        (str (name k) " must be at most " limit " characters")
        nil))))

(defn mask-token [v]
  (if (or (nil? v) (not (string? v)) (str/blank? v))
    {:present false}
    {:present true :preview (subs (str v) (max 0 (- (count (str v)) 4)))}))

(defn mask-settings [settings]
  (let [base {:pi_default_provider (or (:pi_default_provider settings) nil)
              :pi_default_model (or (:pi_default_model settings) nil)
              :default_repo_root (or (:default_repo_root settings) nil)}]
    (-> base
        (api-value)
        (assoc :github_token (mask-token (:github_token settings))
               :jira_token (mask-token (:jira_token settings))))))

(defn get-settings
  ([] (get-settings {}))
  ([options]
   (let [{:keys [project global]} (settings-paths options)
         project-settings (coerce-settings (read-settings-file project))
         global-settings (coerce-settings (read-settings-file global))
         [source raw] (cond
                        (seq project-settings) ["project" project-settings]
                        (seq global-settings) ["global" global-settings]
                        :else ["none" {}])
         masked (-> raw (mask-settings) (assoc :source source))]
     {:settings masked})))

(defn set-settings
  "Apply a partial update to the project (or global) settings file. `updates`
  maps known field keywords to their new values. Entries may be nil (clear the
  field) or, for token fields, the `settings-unchanged` sentinel to preserve.
  Unknown keys are rejected. Returns the masked `get-settings` view."
  ([options updates] (set-settings options updates false))
  ([options updates global?]
   (if (empty? updates)
     (get-settings options)
     (let [unknown (remove (set settings-fields) (keys updates))]
       (if (seq unknown)
         (error-response 400 "bad_request"
                         (str "Unknown settings fields: "
                              (str/join ", " (map name (sort unknown)))))
         (let [errs (reduce (fn [acc [k v]]
                              (if-let [e (validate-settings-field k v)]
                                (conj acc e) acc))
                            [] updates)]
           (if (seq errs)
             (error-response 400 "bad_request" (str/join "; " errs))
             (let [paths (settings-paths options)
                   target (if global? (:global paths) (:project paths))
                   current (coerce-settings (read-settings-file target))
                   merged (reduce
                              (fn [acc [k v]]
                                (cond
                                  ;; Token unchanged: keep whatever is (or isn't) there.
                                  (and (settings-token-fields k)
                                       (= v settings-unchanged))
                                  acc
                                  ;; Clear: drop the key entirely (nil update).
                                  (nil? v) (dissoc acc k)
                                  ;; Set/replace.
                                  :else (assoc acc k v)))
                              current updates)]
               ;; Cross-field consistency: a default model without a default
               ;; provider is an inconsistent state. Reject it here so the
               ;; store never holds model-without-provider (this also defends
               ;; the CLI and direct API callers, not just the web UI).
               (if (and (contains? merged :pi_default_model)
                        (not (contains? merged :pi_default_provider)))
                 (error-response 400 "bad_request"
                                 "pi_default_provider is required when pi_default_model is set")
                 (do
                   (fs/create-dirs (fs/parent target))
                   (store/write-json! target merged)
                   (get-settings options)))))))))))
