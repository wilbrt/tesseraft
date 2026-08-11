(ns tesseraft.lint.pipeline
  (:require [tesseraft.lint.diagnostics :refer [err]]
            [tesseraft.lint.fragments :as fragments]
            [tesseraft.lint.graph :as graph]
            [tesseraft.lint.nodes :as nodes]
            [tesseraft.lint.policy :as policy]
            [tesseraft.lint.resources :as resources]
            [tesseraft.lint.templates :as templates]
            [tesseraft.spec :as spec]))

(def fragment-node-results fragments/fragment-node-results)
(def fragment-inclusion-results fragments/fragment-inclusion-results)
(def workflow-with-fragment-boundary-resources fragments/workflow-with-fragment-boundary-resources)
(def top-level-checks nodes/top-level-checks)
(def node-type-checks nodes/node-type-checks)
(def transition-checks nodes/transition-checks)
(def reachability-checks nodes/reachability-checks)
(def node-contract-checks nodes/node-contract-checks)
(def duplicate-output-checks graph/duplicate-output-checks)
(def workflow-resource-checks resources/workflow-resource-checks)
(def cycle-checks graph/cycle-checks)
(def template-var-checks templates/checks)
(def policy-checks policy/checks)

(defn lint-workflow
  ([wf] (lint-workflow wf {}))
  ([wf opts]
   (let [fragment-results (fragment-node-results wf opts)
         inclusions (fragment-inclusion-results fragment-results)
         analysis-wf (workflow-with-fragment-boundary-resources wf inclusions)
         diagnostics (vec (remove nil?
                                  (concat
                                    (top-level-checks wf)
                                    (node-type-checks wf)
                                    (transition-checks wf)
                                    (reachability-checks wf)
                                    (node-contract-checks wf opts)
                                    (mapcat (comp :diagnostics second) fragment-results)
                                    (duplicate-output-checks analysis-wf)
                                    (workflow-resource-checks analysis-wf)
                                    (cycle-checks analysis-wf)
                                    (template-var-checks wf)
                                    (policy-checks wf))))
         strict? (:strict opts)
         errors (filter #(or (= "error" (:severity %))
                             (and strict? (= "warning" (:severity %)))) diagnostics)
         warnings (filter #(= "warning" (:severity %)) diagnostics)]
     (cond-> {:ok (empty? errors)
              :workflow (spec/workflow-file wf)
              :errors (vec errors)
              :warnings (vec warnings)
              :diagnostics diagnostics}
       (seq inclusions) (assoc :fragment-inclusions inclusions)))))

(defn lint-file
  ([workflow-file] (lint-file workflow-file {}))
  ([workflow-file opts]
   (try
     (let [wf (spec/read-workflow workflow-file)]
       (lint-workflow wf opts))
     (catch Throwable t
       {:ok false
        :workflow (str workflow-file)
        :errors [(err :parse-error [] (.getMessage t))]
        :warnings []
        :diagnostics [(err :parse-error [] (.getMessage t))]}))))
