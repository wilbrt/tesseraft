(ns tesseraft.runtime.identity
  "Canonical namespace-preserving workflow state identity for durable wire
  records and confined run-local path segments.")

(defn state-string [state-id]
  (cond
    (keyword? state-id) (if-let [ns (namespace state-id)]
                          (str ns "/" (name state-id))
                          (name state-id))
    :else (str state-id)))

(defn encoded-state-id [state-id]
  (let [encoded (java.net.URLEncoder/encode (state-string state-id) "UTF-8")]
    ;; URLEncoder intentionally preserves dots. They are ordinary state IDs on
    ;; the wire but must never become filesystem traversal aliases.
    (case encoded
      "." "%2E"
      ".." "%2E%2E"
      encoded)))

(defn approval-id [state-id attempt]
  (str (encoded-state-id state-id) "-" attempt))
