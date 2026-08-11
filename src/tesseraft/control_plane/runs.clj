(ns tesseraft.control-plane.runs
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.string :as str]
            [tesseraft.control-plane.common :as common]
            [tesseraft.control-plane.projects :as projects]
            [tesseraft.runtime.store :as store]
            [tesseraft.spec :as spec]))

(def opts common/opts)
(def api-value common/api-value)
(def error-response common/error-response)
(def abs-path common/abs-path)
(def relative-path common/relative-path)
(def project-scoped-opts projects/project-scoped-opts)

(defn nested-fragment-run-state-file?
  "True when a state.edn path belongs to an internal fragment run rather than
  a top-level run in the control-plane inventory."
  [root p]
  (let [rel-dirs (butlast (str/split (str (fs/relativize root p)) #"/"))]
    (boolean (some #{"fragments"} (drop 2 rel-dirs)))))

(defn run-state-files
  ([options] (run-state-files options nil))
  ([options project-id]
   (let [sopts (project-scoped-opts options project-id)]
     (if (:error sopts)
       sopts
       (let [{:keys [workspace-root runs-root]} sopts
             root (abs-path workspace-root runs-root)]
         (if-not (fs/exists? root)
           []
           (->> (for [p (file-seq (fs/file root))
                      :when (and (.isFile p) (= "state.edn" (.getName p)))]
                  (fs/path p))
                (remove #(nested-fragment-run-state-file? root %))
                (sort-by str)
                vec)))))))

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
  :liveness (one of done/failed/cancelled/orphaned/stale/executing/parked) and
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
         non-terminal (not (#{"done" "failed" "error" "cancelled"} (str status)))
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
        (= "cancelled" (str status)) "cancelled"
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
                 :project_id (or (:project-id run) "default")
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
  ([options] (list-runs options nil))
  ([options project-id]
   (let [sopts (project-scoped-opts options project-id)]
     (if (:error sopts)
       sopts
       (let [entries (mapv (fn [state-file]
                             (try
                               {:run (api-value (run-summary sopts state-file))}
                               (catch Throwable t
                                 {:error {:code "parse_error"
                                          :message (.getMessage t)
                                          :details {:path (relative-path (:workspace-root sopts) state-file)}}})))
                           (run-state-files options project-id))]
         {:runs (mapv :run (filter :run entries))
          :errors (mapv :error (filter :error entries))})))))

(defn matching-run-files
  ([options run-id] (matching-run-files options run-id nil))
  ([options run-id project-id]
   (let [pid (or project-id "default")]
     (->> (run-state-files options project-id)
          (keep (fn [state-file]
                  (try
                    (let [ctx (store/load-context (run-dir-from-state-file state-file))
                          recorded-id (get-in ctx [:run :id])
                          dir-id (str (fs/file-name (run-dir-from-state-file state-file)))
                          id-match? (or (= (str run-id) (str recorded-id))
                                        (= (str run-id) dir-id))
                          ;; Run identity is (project_id, run_id): a run matches
                          ;; only when its recorded :project-id equals the
                          ;; requested project, OR the run predates project
                          ;; stamping and the request is for the default project.
                          ;; This lets two projects share the same run_id without
                          ;; colliding even when they share a runs-root.
                          recorded-pid (get-in ctx [:run :project-id])
                          pid-match? (or (= pid (str recorded-pid))
                                        (and (nil? recorded-pid)
                                             (= "default" pid)))]
                      (when (and id-match? pid-match?)
                        {:state-file state-file :run-dir (run-dir-from-state-file state-file) :context ctx}))
                  (catch Throwable _ nil))))
          vec))))

(defn resolve-run
  ([options run-id] (resolve-run options run-id nil))
  ([options run-id project-id]
   (let [pid (or project-id "default")
         sopts (project-scoped-opts options project-id)]
     (if (:error sopts)
       sopts
       (let [matches (matching-run-files options run-id project-id)]
         (cond
           (empty? matches) (error-response 404 "not_found" "Run not found" {:run_id run-id :project_id pid})
           (> (count matches) 1) (error-response 409 "conflict" "Multiple runs share this run id"
                                                 {:run_id run-id
                                                  :paths (mapv #(relative-path (:workspace-root sopts) (:run-dir %)) matches)})
           :else (first matches)))))))

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

;; fragment.started/finished/resumed are parent-native events (written
;; directly by tesseraft.runtime.fragment, not copies store/event! mirrors),
;; and happen to share the parent inclusion's own :state/:attempt -- exclude
;; them explicitly rather than relying on derive-attempts-from-events'
;; default case to ignore their stripped, non-"node.*"/"transition.*" names.
(def ^:private fragment-native-event-names #{"fragment.started" "fragment.finished" "fragment.resumed"})

(defn- fragment-mirrored-event? [event]
  (let [event-name-str (str (event-name event))]
    (and (str/starts-with? event-name-str "fragment.")
         (not (contains? fragment-native-event-names event-name-str)))))

(defn- unmirror-fragment-event
  "Reverse tesseraft.runtime.store's mirroring transform: strip the
  \"fragment.\" prefix and swap :internal_state/:internal_attempt back onto
  :state/:attempt, reconstructing the exact internal event derive-attempts-
  from-events would have seen reading the nested run's own events.jsonl."
  [event]
  (-> event
      (assoc :event (subs (event-name event) (count "fragment.")))
      (assoc :state (:internal_state event))
      (assoc :attempt (:internal_attempt event))
      (dissoc :internal_state :internal_attempt)))

(defn internal-attempts-for-parent-attempt
  "Nested attempts for one parent attempt (identified by its own :state and
  :attempt), reconstructed from this run's own mirrored fragment.* events --
  no separate read of the nested run dir is needed."
  [events state attempt]
  (->> events
       (filter (fn [e] (and (fragment-mirrored-event? e)
                            (= state (:state e))
                            (= attempt (:attempt e)))))
       (mapv unmirror-fragment-event)
       derive-attempts-from-events))

(defn attach-internal-attempts
  "Additive: attaches :internal_attempts on a parent attempt only when a
  fragment inclusion at that attempt actually mirrored internal events."
  [events attempts]
  (mapv (fn [attempt]
          (let [internal (internal-attempts-for-parent-attempt events (:state attempt) (:attempt attempt))]
            (cond-> attempt (seq internal) (assoc :internal_attempts internal))))
        attempts))

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
  (let [roots ["state.edn" "events.jsonl" "issues.json" "logs" "prompts/generated" "attempts" "fragments"]]
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
  ([] (get-run-artifacts {} nil nil))
  ([options run-id] (get-run-artifacts options run-id nil))
  ([options run-id project-id]
   (let [resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (let [events (read-events-file (events-file (:run-dir resolved)))]
         (if (:error events)
           events
           (api-value {:run_id run-id :artifacts (list-artifacts* (:context resolved) (:run-dir resolved) events)})))))))

(defn read-run-artifact
  ([] (read-run-artifact {} nil nil nil))
  ([options run-id artifact-path] (read-run-artifact options run-id artifact-path nil))
  ([options run-id artifact-path project-id]
   (let [resolved (resolve-run options run-id project-id)]
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
               :when (not (str/starts-with? (:path artifact) "fragments/"))
               :when (issues-artifact-has-issues? run-dir (:path artifact))]
           {:source "artifact" :path (:path artifact) :message "Issues artifact present"}))))

(defn get-run
  ([] (get-run {} nil nil))
  ([options run-id] (get-run options run-id nil))
  ([options run-id project-id]
   (let [sopts (project-scoped-opts options project-id)
         resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (let [{:keys [context state-file run-dir]} resolved
             summary (run-summary sopts state-file)
             run-id (:run_id summary)
             events (read-events-file (events-file run-dir))
             attempts (if (:error events) [] (attach-internal-attempts events (attempts-from-context context events)))
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
  ([] (get-run-events {} nil nil))
  ([options run-id] (get-run-events options run-id nil))
  ([options run-id project-id]
   (let [resolved (resolve-run options run-id project-id)]
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
  ([] (delete-run {} nil nil))
  ([options run-id] (delete-run options run-id nil))
  ([options run-id project-id]
   (let [sopts (project-scoped-opts options project-id)
         resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (let [{:keys [state-file run-dir context]} resolved
             summary (run-summary sopts state-file)
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
              :path (relative-path (:workspace-root sopts) run-dir)})))))))

;; ---- approvals (manual-input :approval pause/resume) ----
;; Run-relative read surfaces for the manual-input node feature. The runtime
;; writes approvals/<state>-<attempt>.json (request) and
;; approvals/<state>-<attempt>-decision.json (decision) under the run dir; the
;; decision is recorded by `tesseraft runtime decide`. These functions expose
;; them read-only and also support run-relative artifact *comments*
;; (comments/<safe-path>.json arrays). Comments are workflow-behavior-free
;; metadata reconstructed from files (design §4).
