(ns tesseraft.lint.templates
  (:require [clojure.string :as str]
            [tesseraft.lint.diagnostics :refer [err warn]]
            [tesseraft.spec :as spec]))
(defn checks [wf]
  (let [wf-vars (spec/workflow-template-vars wf)
        prompt-vars (set (mapcat (fn [[_ n]] (when (:prompt-template n) (spec/prompt-template-vars wf (:prompt-template n)))) (:states wf)))
        input-keys (set (map name (keys (:inputs wf)))) default-keys (set (map name (keys (:defaults wf))))]
    (apply concat (for [v (set (concat wf-vars prompt-vars)) :let [[root field] (str/split v #"\." 2)]]
      (cond
        (not (contains? spec/allowed-template-roots root)) [(err :unknown-template-root [:templates] (str "Unknown template variable namespace in {{" v "}}"))]
        (and (= root "inputs") field (not (contains? input-keys field))) [(warn :unknown-input-template-var [:templates] (str "Template references undeclared workflow input {{" v "}}"))]
        (and (= root "defaults") field (not (contains? default-keys field))) [(warn :unknown-default-template-var [:templates] (str "Template references undeclared default {{" v "}}"))]
        (and (= root "run") field (not (contains? spec/known-run-vars field))) [(warn :unknown-run-template-var [:templates] (str "Template references unknown run field {{" v "}}"))]
        :else [])))))
