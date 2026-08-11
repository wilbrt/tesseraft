(ns tesseraft.work-tracker.errors)

(defn failure
  ([provider category message] (failure provider category message {}))
  ([provider category message details]
   (merge {:ok false
           :status "error"
           :provider provider
           :category category
           :message message}
          details)))
