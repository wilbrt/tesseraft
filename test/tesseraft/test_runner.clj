(ns tesseraft.test-runner
  (:require [clojure.test :as test]))

(defn -main [& namespace-names]
  (when (empty? namespace-names)
    (binding [*out* *err*]
      (println "Usage: bb --classpath src:test -m tesseraft.test-runner <namespace>..."))
    (System/exit 2))
  (let [namespaces (mapv symbol namespace-names)]
    (doseq [namespace namespaces]
      (require namespace))
    (let [{:keys [fail error]} (apply test/run-tests namespaces)]
      (when (pos? (+ fail error))
        (System/exit 1)))))
