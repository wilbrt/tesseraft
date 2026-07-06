#!/usr/bin/env bb
;; scripts/generate_status.clj
;; Regenerate the README "## Current status" section from STATUS.edn.
;;
;; Usage:
;;   bb scripts/generate_status.clj          # regenerate README in place
;;   bb scripts/generate_status.clj --check  # exit 1 if README is out of sync
;;
;; Invoked by the `bb status` task (see bb.edn). No external dependencies;
;; uses only clojure.edn + clojure.string from Babashka's core.

(ns tesseraft.scripts.generate-status
  (:require [clojure.edn :as edn]
            [clojure.string :as str]
            [clojure.java.io :as io]))

(def ^:private repo-root
  (-> (System/getProperty "user.dir") io/file))

(def ^:private status-file
  (io/file repo-root "STATUS.edn"))

(def ^:private readme-file
  (io/file repo-root "README.md"))

(def ^:private begin-marker
  "<!-- BEGIN STATUS — generated from STATUS.edn by `bb status`. Do not edit by hand. -->")

(def ^:private end-marker
  "<!-- END STATUS -->")

(def ^:private valid-statuses
  #{:implemented :partial :not-implemented})

(defn- read-status-edn []
  (when-not (.exists status-file)
    (throw (ex-info (str "STATUS.edn not found at " (.getAbsolutePath status-file)) {})))
  (let [text (slurp status-file)]
    (try
      (edn/read-string text)
      (catch Exception e
        (throw (ex-info (str "Failed to parse STATUS.edn: " (ex-message e))
                        {:cause e}))))))

(defn- validate! [data]
  (when-not (map? data)
    (throw (ex-info "STATUS.edn must be an EDN map" {})))
  (let [root (:tesseraft data)]
    (when-not (map? root)
      (throw (ex-info "STATUS.edn must have a top-level :tesseraft map" {})))
    (let [caps (:capabilities root)]
      (when-not (map? caps)
        (throw (ex-info ":tesseraft/:capabilities must be a map" {})))
      (doseq [[k v] caps]
        (let [status (:status v)
              evidence (:evidence v)]
          (when-not (contains? valid-statuses status)
            (throw (ex-info (str "Capability " k " has invalid :status " (pr-str status)
                                 "; expected one of " (sort valid-statuses))
                             {})))
          (when-not (and (vector? evidence) (seq evidence))
            (throw (ex-info (str "Capability " k " must have non-empty :evidence vector")
                            {}))))))
    root))

(defn- render-capability [[k v]]
  (let [status (:status v)
        summary (:summary v)
        evidence (:evidence v)
        gap (:gap v)
        label (name k)
        status-tag (str "(" (name status) ")")]
    (str
     (format "- **%s** %s — %s" label status-tag summary)
     (when gap
       (str "  \n  _Gap:_ " gap))
     (str "  \n  _Evidence:_ " (str/join ", " evidence)))))

(defn- render-section [root]
  (let [caps (:capabilities root)
        not-yet (:not-yet-implemented root)
        ;; Group by status, preserving declared order within each group.
        order (keys caps)
        grouped (group-by #(get-in caps [% :status]) order)
        impl (filter some? (mapcat grouped [:implemented]))
        part (filter some? (mapcat grouped [:partial]))
        notimpl (filter some? (mapcat grouped [:not-implemented]))]
    (str/join
     "\n\n"
     (filter seq
             [(when (seq impl)
                (str "Implemented:\n\n"
                     (str/join "\n" (map #(render-capability [% (caps %)]) impl))))
              (when (seq part)
                (str "Partial:\n\n"
                     (str/join "\n" (map #(render-capability [% (caps %)]) part))))
              (when (seq notimpl)
                (str "Not implemented:\n\n"
                     (str/join "\n" (map #(render-capability [% (caps %)]) notimpl))))
              (when (and (seq not-yet) (or (seq impl) (seq part) (seq notimpl)))
                (str "Not yet implemented:\n\n"
                     (str/join "\n" (map #(str "- " %) not-yet))))]))))

(defn- current-readme []
  (if (.exists readme-file)
    (slurp readme-file)
    (throw (ex-info (str "README.md not found at " (.getAbsolutePath readme-file)) {}))))

(defn- split-readme [text]
  (let [begin-idx (str/index-of text begin-marker)
        end-idx (str/index-of text end-marker)]
    (when (or (nil? begin-idx) (nil? end-idx))
      (throw (ex-info (str "README.md is missing STATUS sentinel markers. "
                           "Insert `" begin-marker "` and `" end-marker "` "
                           "around the generated status content, then run `bb status`.")
                      {})))
    (when (>= begin-idx end-idx)
      (throw (ex-info "README.md STATUS markers are out of order (BEGIN after END)" {})))
    (let [pre (subs text 0 begin-idx)
          post-idx (+ end-idx (count end-marker))
          post (subs text post-idx)]
      {:pre pre :post post})))

(defn- generated-body [root]
  (str begin-marker "\n" (render-section root) "\n" end-marker))

(defn -main
  [& args]
  (let [check? (boolean (some #{"--check"} args))
        root (-> (read-status-edn) (validate!))
        body (generated-body root)
        text (current-readme)
        {:keys [pre post]} (split-readme text)
        expected (str pre body post)]
    (if check?
      (if (= text expected)
        (do (println "STATUS.edn and README.md are in sync.")
          (System/exit 0))
        (do (binding [*out* *err*]
              (println "README.md status section is out of sync with STATUS.edn.")
              (println "Run `bb status` to regenerate, then commit README.md + STATUS.edn together."))
          (System/exit 1)))
      ;; regenerate in place
      (do (spit readme-file expected)
          (println "Regenerated README.md status section from STATUS.edn.")
          (System/exit 0)))))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
