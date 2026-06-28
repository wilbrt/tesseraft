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

(defn attempts-from-context [ctx]
  (or (:attempts ctx)
      (get-in ctx [:run :attempts])
      []))

(defn get-run
  ([] (get-run {} nil))
  ([options run-id]
   (let [resolved (resolve-run options run-id)]
     (if (:error resolved)
       resolved
       (let [{:keys [context state-file]} resolved
             summary (run-summary options state-file)
             run-id (:run_id summary)]
         (api-value
           {:run (assoc summary
                        :attempts (attempts-from-context context)
                        :links {:events (str "/runs/" run-id "/events")})}))))))

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
