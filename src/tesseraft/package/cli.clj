(ns tesseraft.package.cli
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [tesseraft.cli-args :as cli-args]))

(defn parse-id [value]
  (cond
    (keyword? value) value
    (and (string? value) (str/starts-with? value ":")) (keyword (subs value 1))
    (string? value) (keyword value)
    :else value))

(defn parse-lint-args [args package-key]
  (loop [xs args acc {package-key [] :format "human"}]
    (if (empty? xs)
      acc
      (let [[arg value & more] xs
            rest-xs (rest xs)]
        (case arg
          "--format" (recur more (assoc acc :format (cli-args/require-value arg value)))
          "--strict" (recur rest-xs (assoc acc :strict true))
          "--known-handler" (recur more (update acc :known-handlers (fnil conj []) (keyword (cli-args/require-value arg value))))
          "--known-executor" (recur more (update acc :known-executors (fnil conj []) (keyword (cli-args/require-value arg value))))
          "--allowed-tool" (recur more (update acc :allowed-tools (fnil conj []) (keyword (cli-args/require-value arg value))))
          (recur rest-xs (update acc package-key conj arg)))))))

(defn print-human-result [result]
  (println (if (:ok result) "OK" "FAILED")
           (or (:node-package result) (:fragment-package result) (:workflow result)))
  (doseq [diagnostic (:diagnostics result)]
    (println (str (str/upper-case (:severity diagnostic))
                  " " (:code diagnostic)
                  " " (pr-str (:path diagnostic))
                  " - " (:message diagnostic)))))

(defn aggregate [results]
  {:ok (every? :ok results)
   :files (vec results)
   :errors (vec (mapcat :errors results))
   :warnings (vec (mapcat :warnings results))
   :diagnostics (vec (mapcat :diagnostics results))})

(defn print-lint-result! [result format]
  (case format
    "json" (println (json/generate-string result {:pretty true}))
    "edn" (prn result)
    "human" (if (:files result)
              (doseq [entry (:files result)] (print-human-result entry))
              (print-human-result result))
    (print-human-result result)))
