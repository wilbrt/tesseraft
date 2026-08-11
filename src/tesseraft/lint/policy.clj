(ns tesseraft.lint.policy
  (:require [tesseraft.lint.diagnostics :refer [err]]
            [tesseraft.spec :as spec]))
(defn checks [wf]
  (concat
    (when (get-in wf [:policies :forbid-inline-secrets])
      (for [s (filter #(re-find #"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s\}]+" %)
                      (spec/data-strings (dissoc wf :__file :__dir)))]
        (err :possible-inline-secret [:policies :forbid-inline-secrets] (str "Possible inline secret in workflow data: " (subs s 0 (min (count s) 80))))))
    (when (and (get-in wf [:policies :require-max-rounds]) (nil? (get-in wf [:defaults :max-rounds])))
      [(err :missing-max-rounds [:defaults :max-rounds] "Policy requires :defaults/:max-rounds")])) )
