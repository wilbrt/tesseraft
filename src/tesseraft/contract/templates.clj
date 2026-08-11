(ns tesseraft.contract.templates
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [tesseraft.contract.paths :as paths]))
(defn template-vars [s] (when (string? s) (->> (re-seq #"\{\{\s*([^}\s]+)\s*\}\}" s) (map second) set)))
(defn data-strings [x] (cond (string? x) [x] (map? x) (mapcat (fn [[k v]] (concat (data-strings k) (data-strings v))) x) (sequential? x) (mapcat data-strings x) :else []))
(defn workflow-template-vars [wf] (set (mapcat template-vars (data-strings (dissoc wf :__file :__dir)))))
(defn prompt-template-vars [wf path] (let [p (paths/resolve-workflow-path wf path)] (when (and p (fs/exists? p)) (template-vars (slurp p)))))
(defn context-value [ctx var-name] (get-in ctx (map keyword (str/split var-name #"\."))))
(defn render-template-string [s ctx] (if-not (string? s) s (str/replace s #"\{\{\s*([^}\s]+)\s*\}\}" (fn [[_ var-name]] (str (or (context-value ctx var-name) ""))))))
(defn render-data [x ctx] (cond (string? x) (render-template-string x ctx) (map? x) (into (empty x) (map (fn [[k v]] [k (render-data v ctx)]) x)) (vector? x) (mapv #(render-data % ctx) x) (seq? x) (map #(render-data % ctx) x) :else x))
