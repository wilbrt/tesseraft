(ns tesseraft.handlers.common
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]
            [tesseraft.runtime.store :as store]
            [tesseraft.spec :as spec]))

(def ^:dynamic *process-extra-env* {})

(defn- process-opts [opts]
  (update opts :extra-env #(merge *process-extra-env* %)))

(defn shell! [opts & args]
  (let [r (apply p/shell (process-opts (merge {:out :string :err :string :continue true} opts)) args)]
    (when-not (zero? (:exit r))
      (throw (ex-info "Command failed" {:args args :exit (:exit r) :out (:out r) :err (:err r)})))
    (:out r)))
(defn run-dir [ctx] (get-in ctx [:run :dir]))
(defn artifact-path [ctx p]
  (let [rendered (spec/render-template-string p ctx)]
    (str (fs/path (run-dir ctx) rendered))))
(defn write-artifact-json! [ctx p data]
  (store/write-runtime-json! ctx p data))
(defn artifact-text [ctx p]
  (when p
    (let [path (artifact-path ctx p)]
      (when (fs/exists? path)
        (str/trim (slurp path))))))
(defn rendered-runtime-cwd [ctx node]
  (some-> (get-in node [:runtime :cwd]) (spec/render-template-string ctx) not-empty))
(defn repo-dir
  ([ctx] (or (get-in ctx [:run :worktree-dir]) (get-in ctx [:inputs :repo-root]) (get-in ctx [:inputs :repo]) "."))
  ([ctx node]
   (or (rendered-runtime-cwd ctx node)
       (artifact-text ctx (get-in node [:inputs :repo-dir-file]))
       (get-in ctx [:run :worktree-dir])
       (get-in ctx [:inputs :repo-root])
       (get-in ctx [:inputs :repo])
       ".")))

(defn output-path [ctx node output-key fallback]
  (artifact-path ctx (or (get-in node [:outputs output-key :path]) fallback)))

(defn credential-options [ctx]
  (cond-> {}
    (get-in ctx [:run :tesseraft-home]) (assoc :tesseraft-home (get-in ctx [:run :tesseraft-home]))
    (:credential-resolver ctx) (assoc :credential-resolver (:credential-resolver ctx))))

(defn project-context [ctx project-id]
  (let [project (get-in ctx [:run :project-context])
        persisted-id (or (:project_id project) (:project-id project))]
    (when (and (map? project) (= project-id persisted-id)) project)))
