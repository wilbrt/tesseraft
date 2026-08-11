(ns tesseraft.migration.cli
  (:require
    [cheshire.core :as json]
    [clojure.string :as str]
    [tesseraft.migration.credentials :as credentials]
    [tesseraft.migration.project :as project]
    [tesseraft.migration.preferences :as preference-migration]
    [tesseraft.migration.workflows :as workflows]))

(defn- parse-args [args]
  (loop [xs args result {:command nil :mode nil :workspace-root "." :workflow-roots []
                         :project-root nil :legacy-file nil :tesseraft-home nil :format "json"}]
    (if (empty? xs)
      result
      (let [[a b & more] xs]
        (case a
          "inspect" (recur (rest xs) (assoc result :command :inspect))
          "project" (recur (rest xs) (assoc result :command :project))
          "credentials" (recur (rest xs) (assoc result :command :credentials))
          "workflows" (recur (rest xs) (assoc result :command :workflows))
          "--dry-run" (recur (rest xs) (assoc result :mode :dry-run))
          "--apply" (recur (rest xs) (assoc result :mode :apply))
          "--workspace-root" (recur more (assoc result :workspace-root b))
          "--workflow-root" (recur more (update result :workflow-roots conj b))
          "--project-root" (recur more (assoc result :project-root b))
          "--legacy-file" (recur more (assoc result :legacy-file b))
          "--tesseraft-home" (recur more (assoc result :tesseraft-home b))
          "--format" (recur more (assoc result :format b))
          (throw (ex-info (str "Unknown migration argument: " a) {:argument a})))))))

(defn- options [parsed]
  (cond-> (select-keys parsed [:workspace-root :tesseraft-home])
    (seq (:workflow-roots parsed)) (assoc :workflow-roots (:workflow-roots parsed))))

(defn- result [parsed]
  (case (:command parsed)
    :inspect (let [project-report (project/inspect (options parsed) (:project-root parsed))
                   preference-report (preference-migration/inspect (options parsed))
                   workflow-report (workflows/inspect (options parsed))
                   conflicts (vec (concat (:conflicts project-report)
                                          (:conflicts preference-report)
                                          (:conflicts workflow-report)))]
               {:ok (empty? conflicts)
                :operation "migration.inspect"
                :state (cond (seq conflicts) "conflict"
                             (pos? (+ (:applicable project-report)
                                      (:applicable preference-report)
                                      (:applicable workflow-report))) "pending"
                             :else "current")
                :project project-report
                :preferences preference-report
                :workflows workflow-report})
    :project (if (:mode parsed)
               (let [project-inspect (project/inspect (options parsed) (:project-root parsed))
                     preference-inspect (preference-migration/inspect (options parsed))
                     conflicts (vec (concat (:conflicts project-inspect) (:conflicts preference-inspect)))]
                 (if (seq conflicts)
                   {:ok false :operation "migration.project" :mode (name (:mode parsed))
                    :state "conflict" :conflicts conflicts
                    :project project-inspect :preferences preference-inspect}
                   (let [project-result (project/migrate! (options parsed) (:mode parsed) (:project-root parsed))
                         preference-result (preference-migration/migrate! (options parsed) (:mode parsed))
                         migrated? (some #(= "migrated" (:state %)) [project-result preference-result])]
                     {:ok (and (:ok project-result) (:ok preference-result))
                      :operation "migration.project"
                      :mode (name (:mode parsed))
                      :state (cond
                               (not (and (:ok project-result) (:ok preference-result))) "failed"
                               migrated? "migrated"
                               (pos? (+ (:applicable project-result) (:applicable preference-result))) "pending"
                               :else "unchanged")
                      :project project-result
                      :preferences preference-result})))
               {:ok false :state "error" :error {:code "bad_request" :message "Specify --dry-run or --apply"}})
    :workflows (if (:mode parsed)
                 (workflows/migrate! (options parsed) (:mode parsed))
                 {:ok false :state "error" :error {:code "bad_request" :message "Specify --dry-run or --apply"}})
    :credentials (if (:mode parsed)
                   (let [value (credentials/migrate! (options parsed) (:mode parsed) (:legacy-file parsed))]
                     (assoc value
                            :ok (not (contains? value :error))
                            :operation "migration.credentials"
                            :mode (name (:mode parsed))))
                   {:ok false :state "error" :error {:code "bad_request" :message "Specify --dry-run or --apply"}})
    {:ok false :state "error" :error {:code "bad_request" :message "Use inspect, project, credentials, or workflows"}}))

(defn- print-human! [value]
  (println (str (if (:ok value) "OK" "FAILED") " " (:operation value "migration") " — " (:state value)))
  (when-let [n (:applicable value)] (println (str n " applicable migration(s)")))
  (doseq [conflict (:conflicts value)]
    (println (str "CONFLICT " (:code conflict) ": " (:message conflict)))))

(defn -main [& args]
  (try
    (let [parsed (parse-args args)
          value (result parsed)]
      (if (= "human" (:format parsed))
        (print-human! value)
        (println (json/generate-string value {:pretty true})))
      (when-not (:ok value) (System/exit 1)))
    (catch Throwable t
      (println (json/generate-string {:ok false :state "error"
                                     :error {:code "bad_request" :message (.getMessage t)}}))
      (System/exit 2))))
