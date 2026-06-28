(ns tesseraft.runtime.store
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.edn :as edn]
    [clojure.pprint :as pprint]
    [clojure.string :as str]))

(defn now [] (str (java.time.Instant/now)))

(defn sha256 [s]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256") (.getBytes s "UTF-8"))]
    (apply str (map #(format "%02x" (bit-and % 0xff)) digest))))

(defn write-edn! [p data]
  (fs/create-dirs (fs/parent p))
  (spit (str p) (with-out-str (pprint/pprint data)))
  p)
(defn read-edn [p] (edn/read-string (slurp (str p))))
(defn write-json! [p data]
  (fs/create-dirs (fs/parent p))
  (spit (str p) (json/generate-string data {:pretty true}))
  p)
(defn read-json [p] (json/parse-string (slurp (str p)) true))
(defn append-jsonl! [p data]
  (fs/create-dirs (fs/parent p))
  (spit (str p) (str (json/generate-string data) "\n") :append true)
  p)

(defn save-context! [ctx]
  (write-edn! (fs/path (get-in ctx [:run :dir]) "state.edn") ctx)
  ctx)

(defn load-context [run-dir]
  (read-edn (fs/path run-dir "state.edn")))

(defn event! [ctx event]
  (append-jsonl! (fs/path (get-in ctx [:run :dir]) "events.jsonl")
                (assoc event :at (now)))
  ctx)

(defn ensure-run-dirs! [ctx]
  (doseq [d ["logs" "prompts/generated" "pi-sessions" "attempts"]]
    (fs/create-dirs (fs/path (get-in ctx [:run :dir]) d)))
  (when-not (fs/exists? (get-in ctx [:run :issues-file]))
    (write-json! (get-in ctx [:run :issues-file]) []))
  ctx)
