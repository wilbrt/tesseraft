(ns tesseraft.credentials.refs)

(def credential-ref-re #"^(env|tesseraft|github-actions):([^\s]+)$")

(defn credential-ref? [value]
  (and (string? value) (re-find credential-ref-re value)))
