(ns agent-workflow.control-plane.cli
  (:require
    [agent-workflow.control-plane.core :as cp]
    [cheshire.core :as json]
    [clojure.string :as str]))

(defn missing-value? [v]
  (or (nil? v) (str/starts-with? v "--")))

(defn require-value [flag v]
  (when (missing-value? v)
    (throw (ex-info (str "Missing value for " flag) {:flag flag})))
  v)

(defn parse-args [args]
  (loop [xs args acc {:command nil :workspace-root "." :workflow-roots ["examples"] :runs-root ".agent-runs"}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs
            rest-xs (rest xs)]
        (case a
          "--workspace-root" (recur more (assoc acc :workspace-root (require-value a b)))
          "--workflow-root" (recur more (update acc :workflow-roots conj (require-value a b)))
          "--runs-root" (recur more (assoc acc :runs-root (require-value a b)))
          (if (:command acc)
            (recur rest-xs (update acc :args conj a))
            (recur rest-xs (assoc acc :command a))))))))

(defn usage! []
  (binding [*out* *err*]
    (println "Usage:")
    (println "  tesseraft control-plane workflows")
    (println "  tesseraft control-plane workflow <name>")
    (println "  tesseraft control-plane graph <name>")
    (println "  tesseraft control-plane runs")
    (println "  tesseraft control-plane run <run-id>")
    (println "  tesseraft control-plane events <run-id>")
    (println)
    (println "Options:")
    (println "  --workspace-root <dir>   Workspace root (default: .)")
    (println "  --workflow-root <dir>    Additional workflow root (default: examples)")
    (println "  --runs-root <dir>        Runs root (default: .agent-runs)"))
  (System/exit 2))

(defn require-arg [opts label]
  (or (first (:args opts))
      (throw (ex-info (str "Missing " label) {:label label}))))

(defn exit-status [result]
  (if (:error result) 1 0))

(defn print-json! [result]
  (println (json/generate-string result {:pretty true})))

(defn -main [& args]
  (try
    (let [opts (parse-args args)
          command (:command opts)
          options (select-keys opts [:workspace-root :workflow-roots :runs-root])
          result (case command
                   "workflows" (cp/list-workflows options)
                   "workflow" (cp/get-workflow options (require-arg opts "workflow name"))
                   "graph" (cp/get-workflow-graph options (require-arg opts "workflow name"))
                   "runs" (cp/list-runs options)
                   "run" (cp/get-run options (require-arg opts "run id"))
                   "events" (cp/get-run-events options (require-arg opts "run id"))
                   (usage!))]
      (print-json! result)
      (when (not= 0 (exit-status result))
        (System/exit (exit-status result))))
    (catch Throwable t
      (binding [*out* *err*]
        (println (.getMessage t)))
      (System/exit 2))))
