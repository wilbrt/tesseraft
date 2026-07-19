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
  (loop [xs args acc {:inputs {} :max-steps 100 :command "run" :decision nil :summary nil :author-name nil :author-email nil}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs
            rest-xs (rest xs)]
        (case a
          "start" (recur rest-xs (assoc acc :command "start"))
          "step" (recur rest-xs (assoc acc :command "step"))
          "resume" (recur rest-xs (assoc acc :command "resume"))
          "cancel" (recur rest-xs (assoc acc :command "cancel"))
          "inspect" (recur rest-xs (assoc acc :command "inspect"))
          "decide" (recur rest-xs (assoc acc :command "decide"))
          "--input" (let [[k v] (parse-input (cli-args/require-value a b))] (recur more (assoc-in acc [:inputs k] v)))
          "--run-id" (recur more (assoc acc :run-id (cli-args/require-value a b)))
          "--project-id" (recur more (assoc acc :project-id (cli-args/require-value a b)))
          "--runs-root" (recur more (assoc acc :runs-root (cli-args/require-value a b)))
          "--workspace-root" (recur more (assoc acc :workspace-root (cli-args/require-value a b)))
          "--run-dir" (recur more (assoc acc :run-dir (cli-args/require-value a b)))
          "--executor" (recur more (assoc acc :executor (keyword (cli-args/require-value a b))))
          "--mode" (recur more (assoc acc :executor (keyword (cli-args/require-value a b))))
          "--max-steps" (recur more (assoc acc :max-steps (parse-long (cli-args/require-value a b))))
          "--git-user-name" (recur more (assoc-in acc [:git-user :name] (cli-args/require-value a b)))
          "--git-user-email" (recur more (assoc-in acc [:git-user :email] (cli-args/require-value a b)))
          "--approval-id" (recur more (assoc acc :approval-id (cli-args/require-value a b)))
          "--decision" (recur more (assoc acc :decision (cli-args/require-value a b)))
          "--summary" (recur more (assoc acc :summary (cli-args/require-value a b)))
          "--author-name" (recur more (assoc acc :author-name (cli-args/require-value a b)))
          "--author-email" (recur more (assoc acc :author-email (cli-args/require-value a b)))
          "--format" (recur more (assoc acc :format (cli-args/require-value a b)))
          (if (:workflow acc)
            (recur rest-xs acc)
            (recur rest-xs (assoc acc :workflow a))))))))

(defn validate-executor! [opts]
  (when (and (:executor opts) (not= :mock (:executor opts)))
    (throw (ex-info "Unknown runner executor" {:executor (:executor opts)})))
  opts)

(defn apply-run-options [ctx opts]
  (validate-executor! opts)
  (cond-> ctx
    (contains? opts :executor) (assoc-in [:run :executor-mode] (when-let [executor (:executor opts)] (name executor)))))

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
    (println "  tesseraft-run <workflow.edn> --executor mock --run-id dry-run-demo")
    (println "  tesseraft-run start <workflow.edn> --input ticket=PROJ-123")
    (println "  tesseraft-run step --run-dir .agent-runs/name/run-id")
    (println "  tesseraft-run resume --run-dir .agent-runs/name/run-id --max-steps 100")
    (println "  tesseraft-run cancel --run-dir .agent-runs/name/run-id")
    (println "  tesseraft-run inspect --run-dir .agent-runs/name/run-id --format json")
    (println "  tesseraft-run decide --run-dir .agent-runs/name/run-id --approval-id <id> --decision <label> [--summary text] [--author-name x --author-email y]"))
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

(defn validate-options! [opts]
  (-> opts validate-git-user! validate-executor!))

(defn run-registered! [run-dir f]
  (let [pid (runtime/register-runtime-process! run-dir)]
    (try
      (f)
      (finally
        (try
          (when (runtime/terminal-run? (store/load-context run-dir))
            (runtime/stop-owned-processes! run-dir))
          (finally
            (runtime/unregister-runtime-process! run-dir pid)))))))

(defn -main [& args]
  (try
    (let [opts (validate-options! (parse-args args))]
      (case (:command opts)
        "start"
        (do (when (str/blank? (:workflow opts)) (usage!))
            (print-result opts (runtime/start! (:workflow opts) opts)))

        "step"
        (do (when (str/blank? (:run-dir opts)) (usage!))
            (let [ctx (apply-run-options (store/load-context (:run-dir opts)) opts)
                  wf (spec/read-workflow (get-in ctx [:workflow :file]))]
              (print-result opts (store/save-context! (runtime/step! wf ctx)))))

        "resume"
        (do (when (str/blank? (:run-dir opts)) (usage!))
            (let [run-dir (:run-dir opts)
                  ctx (apply-run-options (store/load-context run-dir) opts)
                  wf (spec/read-workflow (get-in ctx [:workflow :file]))]
              (run-registered!
                run-dir
                #(print-result opts (runtime/run-until-done! wf ctx (:max-steps opts))))))

        "cancel"
        (do (when (str/blank? (:run-dir opts)) (usage!))
            (print-result opts (runtime/cancel! (:run-dir opts))))

        "inspect"
        (do (when (str/blank? (:run-dir opts)) (usage!))
            (print-result opts (store/load-context (:run-dir opts))))

        "decide"
        (do (when (str/blank? (:run-dir opts)) (usage!))
            (let [approval-id (:approval-id opts)
                  decision (:decision opts)
                  summary (:summary opts)
                  author (when (and (:author-name opts) (:author-email opts))
                           {:name (:author-name opts) :email (:author-email opts)})
                  result (runtime/decide! (:run-dir opts) approval-id decision summary author)]
              (if (:error result)
                (let [err (:error result)]
                  (println (json/generate-string result {:pretty true}))
                  (System/exit 1))
                (print-result opts result))))

        "run"
        (do (when (str/blank? (:workflow opts)) (usage!))
            (let [ctx (runtime/start! (:workflow opts) opts)
                  wf (spec/read-workflow (:workflow opts))
                  run-dir (get-in ctx [:run :dir])]
              (run-registered!
                run-dir
                #(print-result opts (runtime/run-until-done! wf ctx (:max-steps opts))))))))
    (catch Throwable t
      (binding [*out* *err*]
        (println (.getMessage t)))
      (System/exit 2))))
