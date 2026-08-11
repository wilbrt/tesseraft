(ns tesseraft.capabilities.catalog-test
  (:require
    [clojure.test :refer [deftest is testing]]
    [tesseraft.capabilities.executors :as executors]
    [tesseraft.capabilities.handlers :as handlers]
    [tesseraft.control-plane.core :as control-plane]
    [tesseraft.lint.core :as lint]
    [tesseraft.work-tracker.catalog :as providers]))

(deftest handler-catalog-owns-live-mock-lint-and-public-inventory
  (is (= (handlers/ids) (set (keys handlers/descriptors))))
  (is (= (handlers/ids) (lint/known-handlers {})))
  (doseq [[id descriptor] handlers/descriptors]
    (testing (name id)
      (is (= id (:id descriptor)))
      (is (ifn? (handlers/implementation id :run)))
      (is (ifn? (handlers/implementation id :mock)))
      (is (= #{:deterministic} (:allowed-node-types descriptor)))
      (is (set? (:side-effects descriptor)))
      (is (boolean? (:deprecated? descriptor)))))
  (is (= (handlers/ids)
         (set (map (comp keyword :id) (handlers/public-descriptors))))))

(deftest executor-catalog-makes-unavailable-support-honest
  (is (= (executors/ids) (lint/known-executors {})))
  (is (executors/dispatchable? :pi-cli))
  (is (executors/dispatchable? :claude-code))
  (is (not (executors/dispatchable? :pi-sdk)))
  (is (= "unavailable" (get-in (executors/public-descriptors)
                                [(->> (executors/public-descriptors)
                                      (map-indexed vector)
                                      (some (fn [[index descriptor]]
                                              (when (= :pi-sdk (:id descriptor)) index))))
                                 :availability :status])))
  (doseq [[id descriptor] executors/descriptors
          :when (:dispatchable? descriptor)]
    (is (ifn? (requiring-resolve (:run descriptor))) (name id)))
  (let [workflow {:api-version "tesseraft.workflow/v1" :kind :workflow
                  :metadata {:name "unavailable-executor"}
                  :initial :agent
                  :states {:agent {:type :agent :executor :pi-sdk
                                   :prompt-template "missing.md" :runtime {:timeout "1m"}
                                   :next :done}
                           :done {:type :terminal}}}
        result (lint/lint-workflow workflow)]
    (is (some #(= "executor-unavailable" (:code %)) (:errors result)))))

(deftest provider-catalog-drives-validation-runtime-mock-doctor-and-api
  (is (= #{:plane :jira :github-issues} (providers/ids)))
  (doseq [[id descriptor] providers/descriptors]
    (testing (name id)
      (is (= id (:id descriptor)))
      (is (ifn? (:validate-config descriptor)))
      (is (ifn? (:fetch-item descriptor)))
      (is (ifn? (:mock-scope descriptor)))
      (is (ifn? (:doctor descriptor)))
      (is (seq (:form-fields descriptor)))
      (is (= (name id) (:normalized-provider descriptor)))))
  (let [capabilities (control-plane/list-capabilities)]
    (is (= (handlers/ids) (set (map (comp keyword #(get % "id")) (:handlers capabilities)))))
    (is (= (executors/ids) (set (map (comp keyword #(get % "id")) (:executors capabilities)))))
    (is (= (providers/ids) (set (map (comp keyword #(get % "provider")) (:work_trackers capabilities)))))
    (is (not (re-find #"(?i)token|secret" (pr-str capabilities))))))
