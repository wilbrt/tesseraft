(ns tesseraft.lint.diagnostics)

(defn diag
  ([severity code path message] (diag severity code path message nil))
  ([severity code path message hint]
   (cond-> {:severity (name severity) :code (name code)
            :path (mapv #(if (keyword? %) (name %) %) path) :message message}
     hint (assoc :hint hint))))
(defn err
  ([code path message] (diag :error code path message))
  ([code path message hint] (diag :error code path message hint)))
(defn warn
  ([code path message] (diag :warning code path message))
  ([code path message hint] (diag :warning code path message hint)))
(defn info [code path message] (diag :info code path message))
