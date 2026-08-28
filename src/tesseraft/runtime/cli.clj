(ns tesseraft.runtime.cli
  (:require
    [tesseraft.cli-args :as cli-args]
    [tesseraft.runtime.core :as runtime]
    [tesseraft.runtime.operations :as operations]
    [tesseraft.runtime.process :as runtime-process]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]
    [cheshire.core :as json]
    [clojure.string :as str]))

(defn parse-input [s]
  (let [[k v] (str/split s #"=" 2)] [(keyword k) v]))

(defn parse-json-option [flag s]
  (try
    (json/parse-string s true)
    (catch Throwable t
      (throw (ex-info (str flag " must be JSON") {:flag flag} t)))))

(defn parse-args [args]
  (loop [xs args acc {:inputs {} :max-steps 100 :command "run" :decision nil :summary nil :author-name nil :author-email nil}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs
            rest-xs (rest xs)]
        (case a
          "apply" (recur rest-xs (assoc acc :command "apply"))
          "bootstrap" (recur rest-xs (assoc acc :command "bootstrap"))
          "start" (recur rest-xs (assoc acc :command "start"))
          "step" (recur rest-xs (assoc acc :command "step"))
          "resume" (recur rest-xs (assoc acc :command "resume"))
          "retry" (recur rest-xs (assoc acc :command "retry"))
          "cancel" (recur rest-xs (assoc acc :command "cancel"))
          "inspect" (recur rest-xs (assoc acc :command "inspect"))
          "decide" (recur rest-xs (assoc acc :command "decide"))
          "--input" (if (= "apply" (:command acc))
                      (recur more (assoc acc :input-source (cli-args/require-value a b)))
                      (let [[k v] (parse-input (cli-args/require-value a b))]
                        (recur more (assoc-in acc [:inputs k] v))))
          "--run-id" (recur more (assoc acc :run-id (cli-args/require-value a b)))
          "--project-id" (recur more (assoc acc :project-id (cli-args/require-value a b)))
          "--runs-root" (recur more (assoc acc :runs-root (cli-args/require-value a b)))
          "--workspace-root" (recur more (assoc acc :workspace-root (cli-args/require-value a b)))
          "--tesseraft-home" (recur more (assoc acc :tesseraft-home (cli-args/require-value a b)))
          "--workflow-root" (recur more (update acc :workflow-roots (fnil conj []) (cli-args/require-value a b)))
          "--project-context" (recur more (assoc acc :project-context (parse-json-option a (cli-args/require-value a b))))
          "--run-dir" (recur more (assoc acc :run-dir (cli-args/require-value a b)))
          "--executor" (recur more (assoc acc :executor (keyword (cli-args/require-value a b))))
          "--mode" (recur more (assoc acc :executor (keyword (cli-args/require-value a b))))
          "--max-steps" (recur more (assoc acc :max-steps (parse-long (cli-args/require-value a b))))
          "--git-user-name" (recur more (assoc-in acc [:git-user :name] (cli-args/require-value a b)))
          "--git-user-email" (recur more (assoc-in acc [:git-user :email] (cli-args/require-value a b)))
          "--approval-id" (recur more (assoc acc :approval-id (cli-args/require-value a b)))
          "--decision" (recur more (assoc acc :decision (cli-args/require-value a b)))
          "--summary" (recur more (assoc acc :summary (cli-args/require-value a b)))
          "--reason" (recur more (assoc acc :reason (cli-args/require-value a b)))
          "--repin" (recur rest-xs (assoc acc :repin true))
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
    (println "  tesseraft-run <workflow.edn> --input item-id=PROJ-123")
    (println "  tesseraft-run <workflow.edn> --executor mock --run-id dry-run-demo")
    (println "  tesseraft-run start <workflow.edn> --input item-id=PROJ-123")
    (println "  tesseraft-run step --run-dir .agent-runs/name/run-id")
    (println "  tesseraft-run resume --run-dir .agent-runs/name/run-id --max-steps 100")
    (println "  tesseraft-run retry --run-dir .agent-runs/name/run-id [--max-steps 100] [--reason \"...\"] [--repin]")
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

(defn read-bounded-bootstrap-envelope []
  (let [limit (* 64 1024)
        buffer (char-array 4096)
        output (StringBuilder.)]
    (loop [total 0]
      (let [read (.read *in* buffer)]
        (if (neg? read)
          (json/parse-string (str output) true)
          (let [next-total (+ total read)]
            (when (> next-total limit)
              (throw (ex-info "Execution bootstrap envelope exceeds 64 KiB"
                              {:code :execution_bootstrap_envelope_too_large})))
            (.append output (String. buffer 0 read))
            (recur next-total)))))))

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
        "bootstrap"
        (let [envelope (read-bounded-bootstrap-envelope)
              run-dir (:run-dir envelope)
              pid (runtime-process/bootstrap-intent! envelope)]
          (try
            (let [result (operations/execute-claimed-operation
                           {:operation (:operation envelope)
                            :payload (assoc (:options envelope) :run_dir run-dir)})]
              (println (json/generate-string result {:pretty true}))
              (when (:error result) (System/exit 1)))
            (finally
              (runtime/unregister-runtime-process! run-dir pid))))

        "apply"
        (let [result (if (= "-" (:input-source opts))
                       (operations/apply-operation (json/parse-string (slurp *in*) true))
                       {:status 400 :error {:code "bad_request" :message "apply requires --input -" :details {}}})]
          (println (json/generate-string result {:pretty true}))
          (when (:error result) (System/exit 1)))

        "start"
        (do (when (str/blank? (:workflow opts)) (usage!))
            (print-result opts (runtime/start! (:workflow opts) opts)))

        "step"
        (do (when (str/blank? (:run-dir opts)) (usage!))
            (let [run-dir (:run-dir opts)
                  result (runtime-process/launch-intent! run-dir "run.step"
                           (cond-> {} (:executor opts) (assoc :executor (name (:executor opts)))))]
              (print-result opts {:run (get-in result [:result :run])})))

        "resume"
        (do (when (str/blank? (:run-dir opts)) (usage!))
            (let [run-dir (:run-dir opts)
                  result (runtime-process/launch-intent! run-dir "run.resume"
                           (cond-> {:max_steps (:max-steps opts)}
                             (:executor opts) (assoc :executor (name (:executor opts)))))]
              (print-result opts {:run (get-in result [:result :run])})))

        "retry"
        (do (when (str/blank? (:run-dir opts)) (usage!))
            (let [run-dir (:run-dir opts)]
              ;; Retry prepares a new attempt before requesting a pre-spawn
              ;; execution generation; the bootstrap child reloads that tuple.
              (runtime/retry! run-dir opts)
              (let [result (runtime-process/launch-intent! run-dir "run.resume"
                             (cond-> {:max_steps (:max-steps opts)}
                               (:executor opts) (assoc :executor (name (:executor opts)))))]
                (print-result opts {:run (get-in result [:result :run])}))))

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
                  run-dir (get-in ctx [:run :dir])
                  result (runtime-process/launch-intent! run-dir "run.resume"
                           (cond-> {:max_steps (:max-steps opts)}
                             (:executor opts) (assoc :executor (name (:executor opts)))))]
              (print-result opts {:run (get-in result [:result :run])})))))
    (catch Throwable t
      (binding [*out* *err*]
        (println (.getMessage t)))
      (System/exit 2))))
