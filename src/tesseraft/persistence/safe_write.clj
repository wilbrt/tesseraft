(ns tesseraft.persistence.safe-write
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]))

(defn owner-only!
  "Best-effort POSIX owner-only permissions. Unsupported filesystems retain
  their platform defaults."
  [p]
  (try
    (java.nio.file.Files/setPosixFilePermissions
      (.toPath (fs/file p))
      (java.nio.file.attribute.PosixFilePermissions/fromString "rw-------"))
    (catch UnsupportedOperationException _ nil)
    (catch Throwable _ nil))
  p)

(defn- move-replacing! [source target]
  (try
    (java.nio.file.Files/move
      (.toPath (fs/file source))
      (.toPath (fs/file target))
      (into-array java.nio.file.CopyOption
                  [java.nio.file.StandardCopyOption/ATOMIC_MOVE
                   java.nio.file.StandardCopyOption/REPLACE_EXISTING]))
    (catch Throwable _
      (java.nio.file.Files/move
        (.toPath (fs/file source))
        (.toPath (fs/file target))
        (into-array java.nio.file.CopyOption
                    [java.nio.file.StandardCopyOption/REPLACE_EXISTING])))))

(defn write-bytes!
  ([p content] (write-bytes! p content {}))
  ([p content {:keys [owner-only?]}]
   (let [target (fs/path p)
         parent (fs/parent target)
         tmp (fs/path parent (str "." (fs/file-name target) ".tmp-" (java.util.UUID/randomUUID)))]
     (fs/create-dirs parent)
     (try
       (with-open [channel (java.nio.channels.FileChannel/open
                             (.toPath (fs/file tmp))
                             (into-array java.nio.file.OpenOption
                                         [java.nio.file.StandardOpenOption/CREATE_NEW
                                          java.nio.file.StandardOpenOption/WRITE]))]
         (.write channel (java.nio.ByteBuffer/wrap content))
         (.force channel true))
       (when owner-only? (owner-only! tmp))
       (move-replacing! tmp target)
       (when owner-only? (owner-only! target))
       target
       (catch Throwable t
         (fs/delete-if-exists tmp)
         (throw t))))))

(defn write-text!
  "Write UTF-8 text through a flushed sibling temporary file and replace the destination."
  ([p content] (write-text! p content {}))
  ([p content options]
   (write-bytes! p (.getBytes (str content) java.nio.charset.StandardCharsets/UTF_8) options)))

(defn write-json!
  ([p data] (write-json! p data {}))
  ([p data options]
   (write-text! p (str (json/generate-string data {:pretty true}) "\n") options)))

(def ^:private append-lock (Object.))

(defn append-text!
  "Append UTF-8 text through the single-writer runtime lock and force it to
  stable storage. Append-only event logs cannot use replacement writes."
  [p content]
  (let [target (fs/path p)]
    (fs/create-dirs (fs/parent target))
    (locking append-lock
      (with-open [channel (java.nio.channels.FileChannel/open
                            (.toPath (fs/file target))
                            (into-array java.nio.file.OpenOption
                                        [java.nio.file.StandardOpenOption/CREATE
                                         java.nio.file.StandardOpenOption/WRITE
                                         java.nio.file.StandardOpenOption/APPEND]))]
        (let [bytes (.getBytes (str content) java.nio.charset.StandardCharsets/UTF_8)]
            (.write channel (java.nio.ByteBuffer/wrap bytes))
            (.force channel true))))
    target))

(defn backup-once!
  "Copy `source` to `backup` without replacing different bytes. Returns the
  backup path and is idempotent for an identical existing backup."
  ([source backup] (backup-once! source backup {}))
  ([source backup {:keys [owner-only?]}]
   (let [source* (fs/path source)
         backup* (fs/path backup)]
     (when (fs/exists? backup*)
       (when-not (= (slurp (str source*)) (slurp (str backup*)))
         (throw (ex-info "Backup already exists with different bytes"
                         {:code :backup-conflict :backup-path (str backup*)}))))
     (when-not (fs/exists? backup*)
       (fs/create-dirs (fs/parent backup*))
       (fs/copy source* backup*)
       (when owner-only? (owner-only! backup*)))
     backup*)))
