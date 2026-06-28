(ns agent-workflow.cli-args
  (:require
    [clojure.string :as str]))

(defn missing-value? [v]
  (or (nil? v) (str/starts-with? v "--")))

(defn require-value [flag v]
  (when (missing-value? v)
    (throw (ex-info (str "Missing value for " flag) {:flag flag})))
  v)
