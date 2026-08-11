(ns tesseraft.security.redaction
  (:require [clojure.string :as str]))

(def secret-key-pattern #"(?i)(token|secret|password|api[-_]?key|authorization|cookie)")

(defn present-secrets [secrets]
  (filter #(and (string? %) (not (str/blank? %))) secrets))

(defn redact-string [value secrets]
  (reduce #(str/replace %1 %2 "[redacted]") (str value) (present-secrets secrets)))

(defn redact
  ([value] (redact value []))
  ([value secrets]
   (cond
     (string? value) (redact-string value secrets)
     (map? value) (into {} (map (fn [[k v]] [k (if (re-find secret-key-pattern (name k)) "[redacted]" (redact v secrets))])) value)
     (vector? value) (mapv #(redact % secrets) value)
     (set? value) (set (map #(redact % secrets) value))
     (seq? value) (mapv #(redact % secrets) value)
     :else value)))
