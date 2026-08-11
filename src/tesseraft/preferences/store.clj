(ns tesseraft.preferences.store
  (:require
    [babashka.fs :as fs]
    [clojure.string :as str]
    [tesseraft.persistence.safe-write :as safe-write]
    [tesseraft.runtime.store :as store]))

(def version 1)
(def fields #{:color_scheme :editor_layout :pi_default_provider :pi_default_model :default_repo_root})

(defn path [tesseraft-home]
  (fs/path tesseraft-home "preferences.json"))

(defn validate-value [key value]
  (cond
    (nil? value) nil
    (and (= key :color_scheme) (not (#{"classic" "matrix"} value))) "color_scheme must be one of: classic, matrix"
    (and (= key :editor_layout) (not (#{"comfortable" "compact"} value))) "editor_layout must be one of: comfortable, compact"
    (not (string? value)) (str (name key) " must be a string")
    (str/blank? value) (str (name key) " must not be empty")
    (str/includes? value "\n") (str (name key) " must not contain newlines")
    :else nil))

(defn validate [data]
  (cond
    (not (map? data)) "preferences must be a JSON object"
    (not= version (:version data)) "unsupported preferences version"
    (not (map? (:preferences data))) "preferences.preferences must be an object"
    (seq (remove fields (keys (:preferences data)))) "preferences contains unknown fields"
    :else (some (fn [[key value]] (validate-value key value)) (:preferences data))))

(defn read! [tesseraft-home]
  (let [preferences-path (path tesseraft-home)]
    (if-not (fs/exists? preferences-path)
      {:version version :preferences {}}
      (let [data (store/read-json preferences-path)]
        (if-let [error (validate data)]
          (throw (ex-info error {:code :invalid-preferences :path (str preferences-path)}))
          data)))))

(defn write! [tesseraft-home data]
  (if-let [error (validate data)]
    (throw (ex-info error {:code :invalid-preferences :path (str (path tesseraft-home))}))
    (safe-write/write-json! (path tesseraft-home) data {:owner-only? true})))

(defn update-values [data updates]
  (update data :preferences
          (fn [current]
            (reduce-kv (fn [result key value]
                         (if (nil? value) (dissoc result key) (assoc result key value)))
                       (or current {}) updates))))
