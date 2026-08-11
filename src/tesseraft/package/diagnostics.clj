(ns tesseraft.package.diagnostics
  (:require [clojure.string :as str]))

(defn summary [result]
  (str/join "; "
            (map #(str (:severity %) " " (:code %) " " (pr-str (:path %)) " - " (:message %))
                 (:diagnostics result))))
