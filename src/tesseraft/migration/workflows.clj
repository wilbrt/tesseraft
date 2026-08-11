(ns tesseraft.migration.workflows
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.edn :as edn]
    [clojure.string :as str]
    [clojure.walk :as walk]
    [tesseraft.lint.core :as lint]
    [tesseraft.persistence.safe-write :as safe-write]
    [tesseraft.runtime.store :as store]))

(defn- workflow-files [options]
  (let [workspace (fs/absolutize (or (:workspace-root options) "."))
        roots (or (seq (:workflow-roots options)) ["examples"])]
    (->> roots
         (map #(let [p (fs/path %)] (if (fs/absolute? p) p (fs/path workspace p))))
         (filter fs/exists?)
         (mapcat #(file-seq (fs/file %)))
         (filter #(.isFile %))
         (filter #(= "workflow.edn" (.getName %)))
         (mapv #(fs/path %)))))

(defn- replace-template [value]
  (if (string? value)
    (str/replace value "{{inputs.ticket}}" "{{inputs.item-id}}")
    value))

(defn- migrate-node [node]
  (if (= :jira/fetch-ticket (:handler node))
    (-> node
        (assoc :handler :work-tracker/fetch-item)
        (update :outputs (fn [outputs]
                           (let [legacy (:ticket-json outputs)
                                 current (dissoc (or outputs {}) :ticket-json)]
                             (if legacy
                               (assoc current :work-item
                                      (assoc legacy :path "work-tracker/item.json"))
                               current)))))
    node))

(defn- migrate-workflow [workflow]
  (let [workflow* (if (contains? (:inputs workflow) :ticket)
                    (-> workflow
                        (assoc-in [:inputs :item-id] (get-in workflow [:inputs :ticket]))
                        (update :inputs dissoc :ticket))
                    workflow)
        workflow* (update workflow* :states
                          (fn [states] (into {} (map (fn [[id node]] [id (migrate-node node)]) states))))]
    (walk/postwalk replace-template workflow*)))

(defn- inspect-file [path]
  (try
    (let [bytes (slurp (str path))
          workflow (edn/read-string bytes)
          migrated (migrate-workflow workflow)]
      (if (= workflow migrated)
        {:path (str path) :state "current"}
        (let [lint-result (lint/lint-workflow
                            (assoc migrated :__file (str (fs/absolutize path))
                                            :__dir (str (fs/parent (fs/absolutize path)))))]
          (if (:ok lint-result)
            {:path (str path) :state "pending" :candidate migrated
             :source_sha256 (store/sha256 bytes)}
            {:path (str path) :state "conflict"
             :conflicts [{:code "invalid_migrated_workflow"
                          :message "Migrated workflow does not lint cleanly"
                          :diagnostics (:errors lint-result)}]}))))
    (catch Throwable t
      {:path (str path) :state "conflict"
       :conflicts [{:code "unreadable_workflow" :message (.getMessage t)}]})))

(defn inspect [options]
  (let [changes (mapv inspect-file (workflow-files options))
        conflicts (vec (mapcat #(or (:conflicts %) []) changes))
        applicable (count (filter #(= "pending" (:state %)) changes))]
    {:ok (empty? conflicts)
     :operation "migration.workflows.inspect"
     :state (cond (seq conflicts) "conflict" (pos? applicable) "pending" :else "current")
     :applicable applicable
     :changes (mapv #(dissoc % :candidate :conflicts) changes)
     :conflicts conflicts}))

(defn migrate! [options mode]
  (let [files (mapv inspect-file (workflow-files options))
        conflicts (vec (mapcat #(or (:conflicts %) []) files))
        pending (filterv #(= "pending" (:state %)) files)
        base {:ok (empty? conflicts)
              :operation "migration.workflows"
              :mode (name mode)
              :state (cond (seq conflicts) "conflict" (seq pending) "pending" :else "current")
              :applicable (count pending)
              :changes (mapv #(dissoc % :candidate :conflicts) files)
              :conflicts conflicts}]
    (cond
      (seq conflicts) base
      (= :dry-run mode) base
      (not= :apply mode) (assoc base :ok false :state "error"
                           :error {:code "bad_request" :message "Migration mode must be dry-run or apply"})
      (empty? pending) (assoc base :state "unchanged")
      :else
      (let [backups (atom [])]
        (try
          (doseq [{:keys [path candidate source_sha256]} pending]
            (let [backup (str path ".v1.backup")
                  provenance (str path ".migration.json")]
              (safe-write/backup-once! path backup)
              (swap! backups conj {:path path :backup backup})
              (safe-write/write-text! path (str (pr-str candidate) "\n"))
              (safe-write/write-json! provenance
                                     {:version 1
                                      :migration "jira-fetch-ticket-to-work-tracker-fetch-item"
                                      :source_sha256 source_sha256
                                      :backup backup})))
          (let [verified (inspect options)]
            (if (and (:ok verified) (= "current" (:state verified)))
              (assoc verified :operation "migration.workflows" :mode "apply" :state "migrated"
                              :backups (mapv :backup @backups))
              (throw (ex-info "Post-migration workflow validation failed" {:verified verified}))))
          (catch Throwable t
            (doseq [{:keys [path backup]} (reverse @backups)]
              (try (safe-write/write-text! path (slurp backup)) (catch Throwable _ nil)))
            {:ok false :operation "migration.workflows" :mode "apply" :state "failed"
             :error {:code "migration_failed" :message (.getMessage t)}}))))))
