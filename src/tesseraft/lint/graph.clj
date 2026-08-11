(ns tesseraft.lint.graph
  (:require [clojure.string :as str]
            [tesseraft.lint.diagnostics :refer [warn]]
            [tesseraft.spec :as spec]))
(defn duplicate-output-checks [wf]
  (let [pairs (for [[id n] (:states wf) [k p] (spec/outputs-with-paths n)] [p {:state id :output k}])]
    (for [[p entries] (group-by first pairs) :when (> (count entries) 1)]
      (warn :duplicate-output-path [:states] (str "Multiple outputs write to " p ": " (str/join ", " (map #(str (get-in % [1 :state]) "/" (get-in % [1 :output])) entries)))))))
(defn graph-has-cycle? [wf]
  (let [g (spec/graph wf)]
    (letfn [(visit [state visiting visited] (cond (visiting state) true (visited state) false :else (boolean (some #(visit % (conj visiting state) (conj visited state)) (get g state)))))]
      (boolean (some #(visit % #{} #{}) (keys g))))))
(defn cycle-checks [wf]
  (when (and (graph-has-cycle? wf) (nil? (get-in wf [:defaults :max-rounds])))
    [(warn :cycle-without-explicit-limit [:defaults :max-rounds] "Workflow contains a cycle but no :defaults/:max-rounds limit")]))
