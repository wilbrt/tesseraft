(ns agent-workflow.lint.cli
  (:require
    [agent-workflow.lint.core :as lint]
    [agent-workflow.spec :as spec]
    [cheshire.core :as json]
    [clojure.string :as str]))

(defn missing-value? [v]
  (or (nil? v) (str/starts-with? v "--")))

(defn require-value [flag v]
  (when (missing-value? v)
    (throw (ex-info (str "Missing value for " flag) {:flag flag})))
  v)

(defn parse-args [args]
  (loop [xs args acc {:workflows [] :format "human"}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs
            rest-xs (rest xs)]
        (case a
          "--format" (recur more (assoc acc :format (require-value a b)))
          "--strict" (recur rest-xs (assoc acc :strict true))
          "--emit" (recur more (assoc acc :emit (require-value a b)))
          "--known-handler" (recur more (update acc :known-handlers (fnil conj []) (keyword (require-value a b))))
          "--known-executor" (recur more (update acc :known-executors (fnil conj []) (keyword (require-value a b))))
          "--allowed-tool" (recur more (update acc :allowed-tools (fnil conj []) (keyword (require-value a b))))
          (recur rest-xs (update acc :workflows conj a)))))))

(defn print-human-result [result]
  (println (if (:ok result) "OK" "FAILED") (:workflow result))
  (doseq [d (:diagnostics result)]
    (println (str (str/upper-case (:severity d))
                  " " (:code d)
                  " " (pr-str (:path d))
                  " - " (:message d)))))

(defn aggregate [results]
  {:ok (every? :ok results)
   :files (vec results)
   :errors (vec (mapcat :errors results))
   :warnings (vec (mapcat :warnings results))
   :diagnostics (vec (mapcat :diagnostics results))})

(defn emit! [opts wf]
  (case (:emit opts)
    "graph" (println (json/generate-string {:nodes (vec (map (fn [[id n]] {:id (name id) :type (name (:type n)) :title (:title n)}) (:states wf)))
                                             :edges (vec (for [[from targets] (spec/graph wf)
                                                          to targets]
                                                      {:from (name from) :to (name to)}))}
                                            {:pretty true}))
    "mermaid" (print (spec/mermaid wf))
    "normalized" (println (json/generate-string (dissoc wf :__file :__dir) {:pretty true}))
    (throw (ex-info "Unknown emit target" {:emit (:emit opts)}))))

(defn -main [& args]
  (try
    (let [opts (parse-args args)
          workflows (:workflows opts)]
      (when (empty? workflows)
        (binding [*out* *err*]
          (println "Usage: agent-workflow-lint <workflow.edn>... [--format human|json|edn] [--strict] [--emit graph|mermaid|normalized]"))
        (System/exit 2))
      (if (:emit opts)
        (doseq [wf-file workflows]
          (emit! opts (spec/read-workflow wf-file)))
        (let [results (mapv #(lint/lint-file % opts) workflows)
              result (if (= 1 (count results)) (first results) (aggregate results))]
          (case (:format opts)
            "json" (println (json/generate-string result {:pretty true}))
            "edn" (prn result)
            "human" (if (:files result)
                      (doseq [r (:files result)] (print-human-result r))
                      (print-human-result result))
            (print-human-result result))
          (when-not (:ok result) (System/exit 1)))))
    (catch Throwable t
      (binding [*out* *err*]
        (println (.getMessage t)))
      (System/exit 2))))
