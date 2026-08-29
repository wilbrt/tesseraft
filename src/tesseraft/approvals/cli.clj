(ns tesseraft.approvals.cli
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [tesseraft.control-plane.core :as control-plane]
            [tesseraft.control-plane.operations :as operations]
            [tesseraft.runtime.process :as runtime-process]))

(defn usage! []
  (binding [*out* *err*]
    (println "Usage:")
    (println "  tesseraft approvals [--project-id <id>] [--run <run-id>]")
    (println "  tesseraft approvals decide --run <run-id> --approval-id <id> --decision <key> [--message <text>] [--annotations-json <json>] [--resume|--no-resume] [--max-steps N]")
    (println "  tesseraft approvals list [--project-id <id>] [--format json]"))
  (System/exit 2))

(defn parse-args [args]
  (loop [xs args acc {:command "interactive" :workspace-root "." :runs-root ".agent-runs"
                      :workflow-roots ["examples"] :max-steps 100 :resume false :format "text"}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs]
        (case a
          "list" (recur (rest xs) (assoc acc :command "list"))
          "decide" (recur (rest xs) (assoc acc :command "decide"))
          "--project-id" (recur more (assoc acc :project-id b))
          "--workspace-root" (recur more (assoc acc :workspace-root b))
          "--runs-root" (recur more (assoc acc :runs-root b))
          "--workflow-root" (recur more (update acc :workflow-roots conj b))
          "--tesseraft-home" (recur more (assoc acc :tesseraft-home b))
          "--run" (recur more (assoc acc :run-id b))
          "--approval-id" (recur more (assoc acc :approval-id b))
          "--decision" (recur more (assoc acc :decision b))
          "--message" (recur more (assoc acc :message b))
          "--annotations-json" (recur more (assoc acc :annotations (json/parse-string b true)))
          "--resume" (recur (rest xs) (assoc acc :resume true))
          "--no-resume" (recur (rest xs) (assoc acc :resume false))
          "--max-steps" (recur more (assoc acc :max-steps (parse-long b)))
          "--format" (recur more (assoc acc :format b))
          (throw (ex-info (str "Unknown approvals argument: " a) {:argument a})))))))

(defn service-options [opts]
  (select-keys opts [:workspace-root :runs-root :workflow-roots :tesseraft-home :project-id]))

(defn pending [opts]
  (let [result (control-plane/get-pending-approvals (service-options opts) (:project-id opts))
        approvals (:approvals result)
        approvals (if-let [run-id (:run-id opts)]
                    (filterv #(= run-id (get % "run_id")) approvals)
                    approvals)]
    (assoc result :approvals approvals)))

(defn print-artifact! [opts approval artifact]
  (let [path (get artifact "path")
        run-id (get approval "run_id")
        label (or (get artifact "label") path)
        result (control-plane/read-run-artifact (service-options opts) run-id path (:project-id opts))]
    (println)
    (println (str "── " label " · " (or (get artifact "kind") "artifact") " ──"))
    (cond
      (:error result) (println (str "Unavailable: " (get-in result [:error :message])))
      (false? (get result "previewable")) (println (str "Preview unavailable: " (get result "reason")))
      :else (println (get result "content")))))

(defn read-answer [prompt]
  (print prompt)
  (flush)
  (some-> (read-line) str/trim))

(defn resume-run! [opts run-id]
  (let [resolved (control-plane/resolve-run (service-options opts) run-id (:project-id opts))]
    (if (:error resolved)
      resolved
      (let [run-dir (str (:run-dir resolved))
            result (runtime-process/launch-intent! run-dir "run.resume"
                                                   {:max_steps (:max-steps opts)})]
        {:run (get-in result [:result :run])}))))

(defn decide! [opts run-id approval-id decision message annotations resume?]
  (let [request {:operation "run.decide"
                 :project_id (:project-id opts)
                 :payload {:run_id run-id :approval_id approval-id
                           :decision decision :message message
                           :annotations (or annotations [])}}
        decided (operations/apply-operation (service-options opts) request)]
    (if (or (:error decided) (not resume?))
      decided
      (assoc decided :resume (resume-run! opts run-id)))))

(defn choose-decision [approval]
  (let [decisions (vec (get approval "decisions"))]
    (doseq [[idx option] (map-indexed vector decisions)]
      (println (format "[%d] %s" (inc idx) (or (get option "label") (get option "decision"))))
      (when-let [consequence (or (get option "consequence") (get option "consequences"))]
        (println (str "    " consequence))))
    (loop []
      (let [answer (read-answer "Decision ([s]kip, [q]uit): ")]
        (cond
          (= "s" answer) :skip
          (= "q" answer) :quit
          (and (parse-long answer) (<= 1 (parse-long answer) (count decisions)))
          (nth decisions (dec (parse-long answer)))
          :else (do (println "Choose one of the numbered decisions, s, or q.") (recur)))))))

(defn review-one! [opts approval idx total]
  (println)
  (println (format "Approval %d of %d" idx total))
  (println (apply str (repeat 72 "=")))
  (println "Workflow:" (get approval "workflow_name"))
  (println "Run:" (get approval "run_id"))
  (println "State:" (get approval "state") "· attempt" (get approval "attempt"))
  (println "Requested:" (get approval "requested_at"))
  (println)
  (println (or (get approval "question") (get approval "message") "Decision required"))
  (doseq [artifact (get approval "artifacts" [])]
    (print-artifact! opts approval artifact))
  (println)
  (let [choice (choose-decision approval)]
    (if (keyword? choice)
      choice
      (let [requires-message (true? (get choice "requires-message"))
            message (read-answer (if requires-message "Reason (required): " "Message (optional): "))]
        (if (and requires-message (str/blank? message))
          (do (println "This decision requires a message; approval was not submitted.") :skip)
          (let [resume-answer (str/lower-case (or (read-answer "Resume immediately? [Y/n] ") ""))
                resume? (not (#{"n" "no"} resume-answer))
                result (decide! opts (get approval "run_id") (get approval "approval_id")
                                (get choice "decision") message [] resume?)]
            (if (:error result)
              (do (println (json/generate-string result {:pretty true})) :skip)
              (do (println "Decision recorded" (if resume? "and run resumed." "without resuming the run.")) :decided))))))))

(defn interactive! [opts]
  (let [result (pending opts)]
    (if (:error result)
      result
      (let [approvals (:approvals result)
            total (count approvals)]
        (if (zero? total)
          (do (println "No pending approvals.") {:ok true :approvals []})
          (loop [idx 0]
            (if (>= idx total)
              {:ok true :reviewed total}
              (let [outcome (review-one! opts (nth approvals idx) (inc idx) total)]
                (if (= :quit outcome)
                  {:ok true :reviewed idx}
                  (recur (inc idx)))))))))))

(defn -main [& args]
  (try
    (let [opts (parse-args args)]
      (case (:command opts)
        "interactive" (interactive! opts)
        "list" (let [result (pending opts)]
                 (if (= "json" (:format opts))
                   (println (json/generate-string result {:pretty true}))
                   (doseq [approval (:approvals result)]
                     (println (get approval "run_id") (get approval "approval_id") "-" (or (get approval "question") (get approval "message")))))
                 (when (:error result) (System/exit 1)))
        "decide" (do
                   (when (some str/blank? [(:run-id opts) (:approval-id opts) (:decision opts)]) (usage!))
                   (let [result (decide! opts (:run-id opts) (:approval-id opts) (:decision opts)
                                         (:message opts) (:annotations opts) (:resume opts))]
                     (println (json/generate-string result {:pretty true}))
                     (when (:error result) (System/exit 1))))))
    (catch Throwable t
      (binding [*out* *err*] (println (.getMessage t)))
      (System/exit 2))))
