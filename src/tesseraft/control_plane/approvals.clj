(ns tesseraft.control-plane.approvals
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [tesseraft.control-plane.common :as common]
            [tesseraft.control-plane.runs :as runs]
            [tesseraft.runtime.store :as store]))

(def opts common/opts)
(def api-value common/api-value)
(def error-response common/error-response)
(def reject-artifact-path runs/reject-artifact-path)
(def resolve-run runs/resolve-run)

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
                     (try
                       (let [request (store/read-json (fs/path f))
                             approval-id (:approval_id request)
                             dec-path (fs/path dir (str approval-id "-decision.json"))
                             decision (when (fs/exists? dec-path) (store/read-json dec-path))]
                         (cond-> request
                           decision (assoc :decision decision)))
                       (catch Throwable _ nil))))
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
  ([] (get-run-approvals {} nil nil))
  ([options run-id] (get-run-approvals options run-id nil))
  ([options run-id project-id]
   (let [resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (api-value {:run_id run-id :approvals (or (load-approval-summary (:run-dir resolved)) [])})))))

(defn get-run-approval
  ([] (get-run-approval {} nil nil nil))
  ([options run-id approval-id] (get-run-approval options run-id approval-id nil))
  ([options run-id approval-id project-id]
   (let [resolved (resolve-run options run-id project-id)]
     (if (:error resolved)
       resolved
       (let [result (load-approval (:run-dir resolved) approval-id)]
         (if (:error result) result (api-value result)))))))

(defn get-run-comments
  ([] (get-run-comments {} nil nil nil))
  ([options run-id] (get-run-comments options run-id nil))
  ([options run-id project-id]
   (let [resolved (resolve-run options run-id project-id)]
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
  ([] (add-run-comment {} nil nil nil nil))
  ([options run-id body] (add-run-comment options run-id body nil))
  ([options run-id body project-id]
   (let [{:keys [run-id-in-body]} (opts options)
         body (or body {})]
     (let [resolved (resolve-run options (or run-id run-id-in-body) project-id)]
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
