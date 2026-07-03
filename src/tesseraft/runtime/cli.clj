(ns tesseraft.runtime.cli
  (:require
    [tesseraft.cli-args :as cli-args]
    [tesseraft.runtime.core :as runtime]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]
    [cheshire.core :as json]
    [clojure.string :as str]))

(defn parse-input [s]
  (let [[k v] (str/split s #"=" 2)] [(keyword k) v]))

(defn parse-args [args]
  (loop [xs args acc {:inputs {} :max-steps 100 :command "run"}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs
            rest-xs (rest xs)]
        (case a
          "start" (recur rest-xs (assoc acc :command "start"))
          "step" (recur rest-xs (assoc acc :command "step"))
          "resume" (recur rest-xs (assoc acc :command "resume"))
          "inspect" (recur rest-xs (assoc acc :command "inspect"))
          "--input" (let [[k v] (parse-input (cli-args/require-value a b))] (recur more (assoc-in acc [:inputs k] v)))
          "--run-id" (recur more (assoc acc :run-id (cli-args/require-value a b)))
          "--run-dir" (recur more (assoc acc :run-dir (cli-args/require-value a b)))
          "--max-steps" (recur more (assoc acc :max-steps (parse-long (cli-args/require-value a b))))
          "--git-user-name" (recur more (assoc-in acc [:git-user :name] (cli-args/require-value a b)))
          "--git-user-email" (recur more (assoc-in acc [:git-user :email] (cli-args/require-value a b)))
          "--format" (recur more (assoc acc :format (cli-args/require-value a b)))
          (if (:workflow acc)
            (recur rest-xs acc)
            (recur rest-xs (assoc acc :workflow a))))))))

(defn print-result [opts data]
  (if (= "json" (:format opts))
    (println (json/generate-string data {:pretty true}))
    (do
      (println "run:" (get-in data [:run :id]))
      (println "dir:" (get-in data [:run :dir]))
      (println "state:" (get-in data [:run :state]))
      (println "status:" (get-in data [:run :status])))))

(defn usage! []
  (binding [*out* *err*]
    (println "Usage:")
    (println "  tesseraft-run <workflow.edn> --input ticket=PROJ-123")
    (println "  tesseraft-run start <workflow.edn> --input ticket=PROJ-123")
    (println "  tesseraft-run step --run-dir .agent-runs/name/run-id")
    (println "  tesseraft-run resume --run-dir .agent-runs/name/run-id --max-steps 100")
    (println "  tesseraft-run inspect --run-dir .agent-runs/name/run-id --format json"))
  (System/exit 2))

(defn validate-git-user! [opts]
  (let [name (get-in opts [:git-user :name])
        email (get-in opts [:git-user :email])
        has-name (and name (not (str/blank? name)))
        has-email (and email (not (str/blank? email)))]
    (cond
      (and has-name (not has-email))
      (throw (ex-info "--git-user-name requires --git-user-email" {:flag "--git-user-email"}))
      (and has-email (not has-name))
      (throw (ex-info "--git-user-email requires --git-user-name" {:flag "--git-user-name"})))
    opts))

(defn -main [& args]
  (try
    (let [opts (validate-git-user! (parse-args args))]
      (case (:command opts)
        "start"
        (do (when (str/blank? (:workflow opts)) (usage!))
            (print-result opts (runtime/start! (:workflow opts) opts)))

        "step"
        (do (when (str/blank? (:run-dir opts)) (usage!))
            (let [ctx (store/load-context (:run-dir opts))
                  wf (spec/read-workflow (get-in ctx [:workflow :file]))]
              (print-result opts (store/save-context! (runtime/step! wf ctx)))))

        "resume"
        (do (when (str/blank? (:run-dir opts)) (usage!))
            (let [ctx (store/load-context (:run-dir opts))
                  wf (spec/read-workflow (get-in ctx [:workflow :file]))]
              (print-result opts (runtime/run-until-done! wf ctx (:max-steps opts)))))

        "inspect"
        (do (when (str/blank? (:run-dir opts)) (usage!))
            (print-result opts (store/load-context (:run-dir opts))))

        "run"
        (do (when (str/blank? (:workflow opts)) (usage!))
            (let [ctx (runtime/start! (:workflow opts) opts)
                  wf (spec/read-workflow (:workflow opts))]
              (print-result opts (runtime/run-until-done! wf ctx (:max-steps opts)))))))
    (catch Throwable t
      (binding [*out* *err*]
        (println (.getMessage t)))
      (System/exit 2))))
