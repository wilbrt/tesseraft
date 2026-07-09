(ns tesseraft.fragment.cli
  "Fragment package commands, mirroring tesseraft.node.cli.

  P1.4 scope: `lint` + `import` + one fixture are the required deliverables.
  `export` is minimal/non-blocking for this milestone."
  (:require
    [tesseraft.cli-args :as cli-args]
    [tesseraft.lint.core :as lint]
    [tesseraft.spec :as spec]
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.pprint :as pprint]
    [clojure.string :as str]))

(defn parse-id [s]
  (cond
    (keyword? s) s
    (and (string? s) (str/starts-with? s ":")) (keyword (subs s 1))
    (string? s) (keyword s)
    :else s))

(defn write-edn! [path data]
  (fs/create-dirs (fs/parent path))
  (spit (str path) (with-out-str (pprint/pprint data)))
  path)

(defn same-file-content? [a b]
  (and (fs/exists? a)
       (fs/exists? b)
       (= (slurp (str a)) (slurp (str b)))))

(defn copy-asset! [from-dir to-dir rel-path]
  (when-not (spec/safe-relative-path? rel-path)
    (throw (ex-info "Asset path is not a safe relative path" {:path rel-path})))
  (let [src (fs/path from-dir rel-path)
        dest (fs/path to-dir rel-path)]
    (when-not (fs/exists? src)
      (throw (ex-info "Referenced asset does not exist" {:path rel-path :source (str src)})))
    (if (fs/exists? dest)
      (when-not (same-file-content? src dest)
        (throw (ex-info "Refusing to overwrite different asset" {:path rel-path :destination (str dest)})))
      (do
        (fs/create-dirs (fs/parent dest))
        (fs/copy src dest)))
    rel-path))

(defn copy-assets! [from-dir to-dir assets]
  (doseq [[_ paths] assets
          path paths]
    (copy-asset! from-dir to-dir path))
  assets)

(defn parse-lint-args [args]
  (loop [xs args acc {:fragment-packages [] :format "human"}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs
            rest-xs (rest xs)]
        (case a
          "--format" (recur more (assoc acc :format (cli-args/require-value a b)))
          "--strict" (recur rest-xs (assoc acc :strict true))
          "--known-handler" (recur more (update acc :known-handlers (fnil conj []) (keyword (cli-args/require-value a b))))
          "--known-executor" (recur more (update acc :known-executors (fnil conj []) (keyword (cli-args/require-value a b))))
          "--allowed-tool" (recur more (update acc :allowed-tools (fnil conj []) (keyword (cli-args/require-value a b))))
          (recur rest-xs (update acc :fragment-packages conj a)))))))

(defn fragment-node [as pkg next-id]
  (cond-> {:type :fragment
           :fragment (spec/fragment-package-name pkg)}
    next-id (assoc :next next-id)))

(defn parse-import-args [args]
  (loop [xs args acc {}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs
            rest-xs (rest xs)]
        (case a
          "--as" (recur more (assoc acc :as (parse-id (cli-args/require-value a b))))
          "--next" (recur more (assoc acc :next (parse-id (cli-args/require-value a b))))
          (cond
            (nil? (:fragment-package acc)) (recur rest-xs (assoc acc :fragment-package a))
            (nil? (:workflow acc)) (recur rest-xs (assoc acc :workflow a))
            :else (throw (ex-info (str "Unexpected argument: " a) {:arg a}))))))))

(defn print-human-result [result]
  (println (if (:ok result) "OK" "FAILED") (or (:fragment-package result) (:workflow result)))
  (doseq [d (:diagnostics result)]
    (println (str (str/upper-case (:severity d))
                  " " (:code d)
                  " " (pr-str (:path d))
                  " - " (:message d)))))

(defn aggregate [results]
  {:ok (every? :ok results)
   :files (vec results)
   :errors (vec (mapcat :errors results))
   :warnings (vec (mapcat :warnings results))
   :diagnostics (vec (mapcat :diagnostics results))})

(defn lint-main [args]
  (let [opts (parse-lint-args args)
        fragment-packages (:fragment-packages opts)]
    (when (empty? fragment-packages)
      (binding [*out* *err*]
        (println "Usage: tesseraft fragment lint <fragment.edn>... [--format human|json|edn] [--strict]"))
      (System/exit 2))
    (let [results (mapv #(lint/lint-fragment-package-file % opts) fragment-packages)
          result (if (= 1 (count results)) (first results) (aggregate results))]
      (case (:format opts)
        "json" (println (json/generate-string result {:pretty true}))
        "edn" (prn result)
        "human" (if (:files result)
                  (doseq [r (:files result)] (print-human-result r))
                  (print-human-result result))
        (print-human-result result))
      (when-not (:ok result) (System/exit 1)))))

(defn import-main [args]
  (let [{:keys [fragment-package workflow as next]} (parse-import-args args)]
    (when (or (str/blank? fragment-package) (str/blank? workflow) (nil? as))
      (binding [*out* *err*]
        (println "Usage: tesseraft fragment import <fragment.edn> <workflow.edn> --as <state-id> [--next <state-id>]"))
      (System/exit 2))
    (let [lint-result (lint/lint-fragment-package-file fragment-package)]
      (when-not (:ok lint-result)
        (throw (ex-info "Fragment package failed lint" lint-result))))
    (let [pkg (spec/read-fragment-package fragment-package)
          wf (spec/read-workflow workflow)
          states (:states wf)]
      (when (contains? states as)
        (throw (ex-info "Workflow state already exists" {:state as :workflow workflow})))
      (when (and next (not (contains? states next)))
        (throw (ex-info "--next target does not exist in workflow" {:next next :workflow workflow})))
      (copy-assets! (spec/fragment-package-dir pkg) (spec/workflow-dir wf) (:assets pkg))
      (let [node (fragment-node as pkg next)
            wf* (assoc-in wf [:states as] node)
            result (lint/lint-workflow wf*)]
        ;; Inserting a fresh {:type :fragment} node is an authoring step: the
        ;; user still binds :inputs/:parameters and exit :transitions next. We
        ;; therefore surface diagnostics but do not abort import on the
        ;; expected authoring-pending diagnostics. Only abort on diagnostics
        ;; that indicate a genuinely broken import (unknown package / read
        ;; failure), not on missing-input or uncovered-outcome.
        (let [hard-errors (filter (fn [d]
                                    (and (= "error" (:severity d))
                                         (not (#{:fragment-input-binding-missing
                                                 :fragment-uncovered-outcome
                                                 :dead-end-non-terminal}
                                               (keyword (:code d))))))
                                  (:diagnostics result))]
          (when (seq hard-errors)
            (throw (ex-info "Workflow would fail lint after fragment import" {:result result}))))
        (write-edn! (spec/workflow-file wf) (dissoc wf* :__file :__dir))
        (println (str "Imported fragment " (spec/fragment-package-name pkg) " as " (name as)))))))

(defn export-main [_args]
  (binding [*out* *err*]
    (println "tesseraft fragment export is deferred to P4.3 (extract-fragment refactor).")
    (println "Use `tesseraft fragment lint` / `tesseraft fragment import` for P1.4."))
  (System/exit 2))

(defn -main [& args]
  (try
    (let [[cmd & more] args]
      (case cmd
        "lint" (lint-main more)
        "import" (import-main more)
        "export" (export-main more)
        nil (do
              (binding [*out* *err*]
                (println "Usage: tesseraft fragment <command> [args]")
                (println)
                (println "Commands:")
                (println "  lint      Validate self-contained fragment packages")
                (println "  import    Import a fragment package into a workflow as a {:type :fragment} node")
                (println "  export    (deferred to P4.3) Extract a subgraph as a fragment package"))
              (System/exit 2))
        (throw (ex-info (str "Unknown fragment command: " cmd) {:command cmd}))))
    (catch Throwable t
      (binding [*out* *err*]
        (println (.getMessage t)))
      (System/exit 2))))