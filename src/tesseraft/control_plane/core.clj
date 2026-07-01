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

(defn relative-path [workspace-root p]
  (try
    (str (fs/relativize (abs-path workspace-root ".") (abs-path workspace-root p)))
    (catch Throwable _
      (str p))))

(defn workflow-files [options]
  (let [{:keys [workspace-root workflow-roots]} (opts options)]
    (->> workflow-roots
         (mapcat (fn [root]
                   (let [dir (abs-path workspace-root root)]
                     (when (fs/exists? dir)
                       (for [p (file-seq (fs/file dir))
                             :when (and (.isFile p) (= "workflow.edn" (.getName p)))]
                         (fs/path p))))))
         (remove nil?)
         (sort-by str)
         vec)))

(defn lint-summary [lint-result]
  {:ok (:ok lint-result)
   :errors (count (:errors lint-result))
   :warnings (count (:warnings lint-result))})

(defn read-workflow-entry [options workflow-file]
  (let [{:keys [workspace-root]} (opts options)
        lint-result (lint/lint-file workflow-file)]
    (try
      (let [wf (spec/read-workflow workflow-file)]
        {:name (str (spec/workflow-name wf))
         :path (relative-path workspace-root workflow-file)
         :api_version (:api-version wf)
         :lint (lint-summary lint-result)})
      (catch Throwable t
        {:name nil
         :path (relative-path workspace-root workflow-file)
         :api_version nil
         :lint (lint-summary lint-result)
         :error {:code "parse_error" :message (.getMessage t)}}))))

(defn list-workflows
  ([] (list-workflows {}))
  ([options]
   {:workflows (mapv #(api-value (read-workflow-entry options %))
                     (workflow-files options))}))

(defn workflow-candidates [options name]
  (->> (workflow-files options)
       (keep (fn [p]
               (try
                 (let [wf (spec/read-workflow p)]
                   (when (= (str name) (str (spec/workflow-name wf)))
                     {:file p :workflow wf}))
                 (catch Throwable _ nil))))
       vec))

(defn resolve-workflow [options name]
  (let [matches (workflow-candidates options name)]
    (cond
      (empty? matches) (error-response 404 "not_found" "Workflow not found" {:name name})
      (> (count matches) 1) (error-response 409 "conflict" "Multiple workflows share this name"
                                            {:name name :paths (mapv #(relative-path (:workspace-root (opts options)) (:file %)) matches)})
      :else (first matches))))

(defn get-workflow
  ([] (get-workflow {} nil))
  ([options name]
   (let [resolved (resolve-workflow options name)]
     (if (:error resolved)
       resolved
       (let [{:keys [workspace-root]} (opts options)
             {:keys [file workflow]} resolved
             lint-result (lint/lint-file file)]
         (api-value
           {:workflow {:name (str (spec/workflow-name workflow))
                       :path (relative-path workspace-root file)
                       :api_version (:api-version workflow)
                       :normalized (dissoc workflow :__file :__dir)
                       :lint lint-result}}))))))

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
                            (:outputs node) (assoc :outputs (:outputs node)))))
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

(defn run-summary [options state-file]
  (let [{:keys [workspace-root]} (opts options)
        ctx (store/load-context (run-dir-from-state-file state-file))
        run (:run ctx)
        workflow (:workflow ctx)]
    {:run_id (or (:id run) (str (fs/file-name (run-dir-from-state-file state-file))))
     :workflow_name (:name workflow)
     :workflow_version (:version workflow)
     :state (:state run)
     :status (:status run)
     :round (:round run)
     :attempt (:attempt run)
     :created_at (:created-at run)
     :updated_at (:updated-at run)
     :path (relative-path workspace-root (run-dir-from-state-file state-file))}))

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

(defn failures-from-run [summary attempts artifacts]
  (vec (concat
         (when (#{"failed" "error"} (:status summary)) [{:source "run" :message (str "Run status: " (:status summary))}])
         (for [attempt attempts :when (#{"failed" "error"} (:status attempt))]
           {:source "attempt" :node_id (:node_id attempt) :message (or (:error attempt) "Attempt failed")})
         (for [artifact artifacts :when (and (:exists artifact) (re-find #"(?i)issues.*\.json$" (:path artifact)))]
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
             artifacts (if (:error events) [] (list-artifacts* context run-dir events))]
         (api-value
           {:run (assoc summary
                        :attempts attempts
                        :failures (failures-from-run summary attempts artifacts)
                        :links {:events (str "/runs/" run-id "/events")
                                :artifacts (str "/runs/" run-id "/artifacts")})}))))))

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
