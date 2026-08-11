#!/usr/bin/env bb
(ns tesseraft.scripts.generate-status
  (:require [cheshire.core :as json]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [tesseraft.capabilities.executors :as executors]
            [tesseraft.capabilities.handlers :as handlers]
            [tesseraft.persistence.safe-write :as safe-write]
            [tesseraft.work-tracker.catalog :as work-trackers]))

(def repo-root (io/file (System/getProperty "user.dir")))
(def status-file (io/file repo-root "STATUS.edn"))
(def readme-file (io/file repo-root "README.md"))
(def generated-markdown (io/file repo-root "docs" "generated" "CAPABILITIES.md"))
(def generated-json (io/file repo-root "docs" "generated" "capabilities.json"))
(def begin-marker "<!-- BEGIN STATUS — generated from STATUS.edn by `bb status`. Do not edit by hand. -->")
(def end-marker "<!-- END STATUS -->")
(def valid-statuses #{:implemented :partial :not-implemented})

(defn read-status []
  (try (edn/read-string (slurp status-file))
       (catch Exception e
         (throw (ex-info (str "Failed to parse STATUS.edn: " (ex-message e)) {})))))

(defn catalog-ids [catalog]
  (letfn [(wire-id [id]
            (if-let [ns (namespace id)] (str ns "/" (name id)) (name id)))]
  (case catalog
    :handlers (set (map (comp wire-id :id) (vals handlers/descriptors)))
    :executors (set (map (comp wire-id :id) (vals executors/descriptors)))
    :work-trackers (set (map (comp wire-id :id) (vals work-trackers/descriptors)))
    nil)))

(defn evidence-path [entry]
  (first (str/split entry #"[# ]" 2)))

(defn validate! [data]
  (let [root (:tesseraft data)
        capabilities (:capabilities root)]
    (when-not (and (map? root) (map? capabilities) (seq capabilities))
      (throw (ex-info "STATUS.edn must contain a non-empty :tesseraft/:capabilities map" {})))
    (doseq [[id capability] capabilities]
      (when-not (contains? valid-statuses (:status capability))
        (throw (ex-info (str "Capability " id " has an invalid status") {})))
      (when-not (and (string? (:summary capability)) (not (str/blank? (:summary capability))))
        (throw (ex-info (str "Capability " id " must have a summary") {})))
      (when-not (and (vector? (:evidence capability)) (seq (:evidence capability)))
        (throw (ex-info (str "Capability " id " must have evidence") {})))
      (doseq [entry (:evidence capability)]
        (let [path (io/file repo-root (evidence-path entry))]
          (when-not (.exists path)
            (throw (ex-info (str "Capability " id " references missing evidence: " entry) {})))))
      (when-let [catalog (:catalog capability)]
        (let [declared (set (:ids capability))
              actual (catalog-ids catalog)]
          (when-not (= declared actual)
            (throw (ex-info (str "Capability " id " catalog IDs disagree with " (name catalog)
                                 ": declared=" (sort declared) " actual=" (sort actual)) {}))))))
    root))

(defn status-label [status]
  (case status :implemented "Implemented" :partial "Partial" :not-implemented "Not implemented"))

(defn render-readme [root]
  (str begin-marker "\n"
       "| Capability | Status | Summary |\n"
       "| --- | --- | --- |\n"
       (str/join "\n"
                 (for [[id capability] (:capabilities root)]
                   (format "| `%s` | %s | %s |" (name id) (status-label (:status capability)) (:summary capability))))
       "\n\nDetailed evidence: [docs/generated/CAPABILITIES.md](docs/generated/CAPABILITIES.md).\n"
       end-marker))

(defn render-details [root]
  (str "# Tesseraft capabilities\n\n"
       "> Generated from `STATUS.edn` by `bb status`. Do not edit by hand.\n\n"
       (str/join "\n\n"
                 (for [[id capability] (:capabilities root)]
                   (str "## " (name id) "\n\n"
                        "Status: **" (status-label (:status capability)) "**\n\n"
                        (:summary capability) "\n\n"
                        "Evidence:\n\n"
                        (str/join "\n" (for [entry (:evidence capability)]
                                             (str "- [`" entry "`](../../" (evidence-path entry) ")"))))))
       (when (seq (:not-yet-implemented root))
         (str "\n\n## Not yet implemented\n\n"
              (str/join "\n" (map #(str "- " %) (:not-yet-implemented root)))))
       "\n"))

(defn json-data [root]
  {:generated_from "STATUS.edn"
   :capabilities
   (mapv (fn [[id capability]]
           (cond-> {:id (name id)
                    :status (name (:status capability))
                    :summary (:summary capability)
                    :evidence (:evidence capability)}
             (:catalog capability) (assoc :catalog (name (:catalog capability))
                                          :ids (:ids capability))))
         (:capabilities root))
   :not_yet_implemented (vec (:not-yet-implemented root))})

(defn replace-readme-section [text body]
  (let [begin (str/index-of text begin-marker)
        end (str/index-of text end-marker)]
    (when (or (nil? begin) (nil? end) (>= begin end))
      (throw (ex-info "README.md is missing ordered STATUS sentinel markers" {})))
    (str (subs text 0 begin) body (subs text (+ end (count end-marker))))))

(defn outputs [root]
  {readme-file (replace-readme-section (slurp readme-file) (render-readme root))
   generated-markdown (render-details root)
   generated-json (str (json/generate-string (json-data root) {:pretty true}) "\n")})

(defn -main [& args]
  (let [check? (some #{"--check"} args)
        expected (outputs (validate! (read-status)))
        stale (keep (fn [[file content]]
                      (when (or (not (.exists file)) (not= content (slurp file)))
                        (.getPath file)))
                    expected)]
    (if check?
      (if (empty? stale)
        (println "STATUS.edn, README.md, and generated capability files are in sync.")
        (do (binding [*out* *err*]
              (println "Generated status outputs are out of sync with STATUS.edn:")
              (doseq [path stale] (println " -" path))
              (println "Run `bb status` and commit all generated outputs."))
            (System/exit 1)))
      (do (doseq [[file content] expected] (safe-write/write-text! file content))
          (println "Generated README status summary and detailed capability evidence.")))))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
