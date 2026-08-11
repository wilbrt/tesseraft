(ns tesseraft.security.redaction-test
  (:require [clojure.test :refer [deftest is]]
            [tesseraft.security.redaction :as redaction]))

(deftest recursive-redaction-hides-values-and-secret-fields
  (let [sentinel "tesseraft-secret-sentinel-7b4f"
        value {:message (str "failed with " sentinel)
               :nested [{:authorization sentinel :safe "visible"}]
               :token sentinel}
        result (redaction/redact value [sentinel])]
    (is (not (.contains (pr-str result) sentinel)))
    (is (= "visible" (get-in result [:nested 0 :safe])))
    (is (= "[redacted]" (:token result)))))
