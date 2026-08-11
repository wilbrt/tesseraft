(ns tesseraft.control-plane.common
  (:require [babashka.fs :as fs]
            [clojure.string :as str]))

(def default-options {:workspace-root "." :workflow-roots ["examples"] :tesseraft-home nil :runs-root ".agent-runs"})
(defn opts [options] (merge default-options options))
(defn api-value [x]
  (cond (keyword? x) (name x)
        (map? x) (into {} (map (fn [[k v]] [(if (keyword? k) (name k) (str k)) (api-value v)])) x)
        (vector? x) (mapv api-value x) (seq? x) (mapv api-value x) (set? x) (mapv api-value x) :else x))
(defn error-response
  ([status code message] (error-response status code message {}))
  ([status code message details] {:status status :error {:code code :message message :details details}}))
(defn abs-path [workspace-root p]
  (str (fs/normalize (if (fs/absolute? (fs/path p)) (fs/path p) (fs/path workspace-root p)))))
(defn path-prefix? [parent child]
  (let [p (fs/normalize (fs/absolutize parent)) c (fs/normalize (fs/absolutize child))]
    (or (= p c) (str/starts-with? (str c) (str p java.io.File/separator)))))
(defn relative-path [workspace-root p]
  (try (let [root (fs/normalize (fs/absolutize workspace-root)) path (fs/normalize (fs/absolutize p))]
         (if (path-prefix? root path) (str (fs/relativize root path)) (str path)))
       (catch Throwable _ (str p))))
(defn tesseraft-home [options]
  (or (:tesseraft-home (opts options)) (System/getenv "TESSERAFT_HOME")
      (str (fs/path (System/getProperty "user.home") ".tesseraft"))))
