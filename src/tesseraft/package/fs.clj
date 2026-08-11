(ns tesseraft.package.fs
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [tesseraft.spec :as spec])
  (:import [java.nio.file Files]
           [java.util Arrays]))

(defn path-like-command? [command]
  (and (string? command)
       (or (str/includes? command "/") (str/starts-with? command "."))))

(defn same-file-content? [left right]
  (and (fs/exists? left)
       (fs/exists? right)
       (Arrays/equals (Files/readAllBytes (fs/path left))
                      (Files/readAllBytes (fs/path right)))))

(defn copy-asset! [from-dir to-dir relative-path]
  (when-not (spec/safe-relative-path? relative-path)
    (throw (ex-info "Asset path is not a safe relative path" {:path relative-path})))
  (let [source (fs/path from-dir relative-path)
        destination (fs/path to-dir relative-path)]
    (when-not (fs/exists? source)
      (throw (ex-info "Referenced asset does not exist"
                      {:path relative-path :source (str source)})))
    (if (fs/exists? destination)
      (when-not (same-file-content? source destination)
        (throw (ex-info "Refusing to overwrite different asset"
                        {:path relative-path :destination (str destination)})))
      (do
        (fs/create-dirs (fs/parent destination))
        (fs/copy source destination)))
    relative-path))

(defn copy-assets! [from-dir to-dir assets]
  (doseq [[_ paths] assets
          path paths]
    (copy-asset! from-dir to-dir path))
  assets)
