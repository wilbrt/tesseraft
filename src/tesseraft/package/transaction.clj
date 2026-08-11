(ns tesseraft.package.transaction
  (:require [babashka.fs :as fs]
            [clojure.pprint :as pprint]
            [tesseraft.persistence.safe-write :as safe-write]
            [tesseraft.spec :as spec])
  (:import [java.nio.file CopyOption Files StandardCopyOption]
           [java.util UUID]))

(defn edn-bytes [data]
  (.getBytes (with-out-str (pprint/pprint data)) "UTF-8"))

(defn temp-sibling [destination]
  (fs/path (fs/parent destination)
           (str "." (fs/file-name destination) ".import-" (UUID/randomUUID) ".tmp")))

(defn move-replace! [source destination]
  (Files/move (fs/path source) (fs/path destination)
              (into-array CopyOption [StandardCopyOption/ATOMIC_MOVE
                                      StandardCopyOption/REPLACE_EXISTING])))

(defn copy-new! [source destination]
  (Files/copy (fs/path source) (fs/path destination) (make-array CopyOption 0)))

(defn delete-empty-parents! [path stop-dir]
  (let [stop (.normalize (.toAbsolutePath (fs/path stop-dir)))]
    (loop [parent (fs/parent path)]
      (when (and parent (not= stop (.normalize (.toAbsolutePath (fs/path parent)))))
        (when (try
                (when (and (fs/exists? parent) (empty? (fs/list-dir parent)))
                  (fs/delete parent)
                  true)
                (catch Throwable _ false))
          (recur (fs/parent parent)))))))

(defn rollback! [workflow-file original-bytes installed-assets workflow-written? workflow-dir]
  (when workflow-written?
    (safe-write/write-bytes! workflow-file original-bytes))
  (doseq [destination (reverse installed-assets)]
    (try
      (fs/delete-if-exists destination)
      (delete-empty-parents! destination workflow-dir)
      (catch Throwable _ nil))))

(defn commit! [workflow data asset-plan]
  (let [workflow-file (fs/path (spec/workflow-file workflow))
        workflow-dir (spec/workflow-dir workflow)
        original-bytes (Files/readAllBytes workflow-file)
        workflow-temp (temp-sibling workflow-file)
        installed (atom [])
        workflow-written? (atom false)]
    (try
      (doseq [{:keys [src dest action]} asset-plan]
        (when (= :install action)
          (fs/create-dirs (fs/parent dest))
          (let [asset-temp (temp-sibling dest)]
            (try
              (copy-new! src asset-temp)
              (swap! installed conj dest)
              (move-replace! asset-temp dest)
              (finally (fs/delete-if-exists asset-temp))))))
      (safe-write/write-bytes! workflow-temp (edn-bytes data))
      (move-replace! workflow-temp workflow-file)
      (reset! workflow-written? true)
      true
      (catch Throwable error
        (fs/delete-if-exists workflow-temp)
        (rollback! workflow-file original-bytes @installed @workflow-written? workflow-dir)
        (throw error)))))
