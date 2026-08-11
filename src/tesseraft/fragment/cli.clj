(ns tesseraft.fragment.cli
  "Fragment package commands, mirroring tesseraft.node.cli."
  (:require
    [tesseraft.cli-args :as cli-args]
    [tesseraft.lint.core :as lint]
    [tesseraft.package.cli :as package-cli]
    [tesseraft.package.diagnostics :as package-diagnostics]
    [tesseraft.package.fs :as package-fs]
    [tesseraft.package.transaction :as transaction]
    [tesseraft.spec :as spec]
    [babashka.fs :as fs]
    [clojure.edn :as edn]
    [clojure.string :as str]))

(def parse-id package-cli/parse-id)
(def edn-bytes transaction/edn-bytes)
(def same-file-content? package-fs/same-file-content?)

(defn parse-lint-args [args]
  (package-cli/parse-lint-args args :fragment-packages))

(defn scalar-edn [flag text]
  (let [v (try
            (edn/read-string text)
            (catch Throwable t
              (throw (ex-info (str "Invalid EDN value for " flag ": " (.getMessage t)) {:flag flag :value text}))))]
    (when (or (map? v) (coll? v))
      (throw (ex-info (str flag " value must be one EDN scalar") {:flag flag :value v})))
    v))

(defn split-pair [flag text]
  (let [[k v] (str/split (cli-args/require-value flag text) #"=" 2)]
    (when (or (str/blank? k) (nil? v))
      (throw (ex-info (str flag " must be name=EDN") {:flag flag :value text})))
    [k v]))

(defn add-singleton [acc k flag value]
  (when (contains? acc k)
    (throw (ex-info (str "Duplicate " flag) {:flag flag})))
  (assoc acc k value))

(defn add-binding [acc kind flag text]
  (let [[raw-k raw-v] (split-pair flag text)
        k (parse-id raw-k)
        v (scalar-edn flag raw-v)]
    (when (contains? (get acc kind {}) k)
      (throw (ex-info (str "Duplicate " flag " binding: " raw-k) {:flag flag :name k})))
    (update acc kind assoc k v)))

(defn add-outcome [acc flag text]
  (let [[raw-outcome raw-target] (split-pair flag text)
        outcome (parse-id raw-outcome)
        target (parse-id raw-target)]
    (when (contains? (:outcomes acc {}) outcome)
      (throw (ex-info (str "Duplicate --outcome route: " raw-outcome) {:outcome outcome})))
    (update acc :outcomes assoc outcome target)))

(defn parse-import-args [args]
  (loop [xs args acc {:inputs {} :parameters {} :outcomes {}}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs
            rest-xs (rest xs)]
        (case a
          "--as" (recur more (add-singleton acc :as "--as" (parse-id (cli-args/require-value a b))))
          "--next" (recur more (add-singleton acc :next "--next" (parse-id (cli-args/require-value a b))))
          "--version" (recur more (add-singleton acc :version "--version" (cli-args/require-value a b)))
          "--scope" (recur more (add-singleton acc :scope "--scope" (cli-args/require-value a b)))
          "--prefix" (recur more (add-singleton acc :prefix "--prefix" (cli-args/require-value a b)))
          "--input" (recur more (add-binding acc :inputs "--input" b))
          "--parameter" (recur more (add-binding acc :parameters "--parameter" b))
          "--outcome" (recur more (add-outcome acc "--outcome" b))
          (cond
            (nil? (:fragment-package acc)) (recur rest-xs (assoc acc :fragment-package a))
            (nil? (:workflow acc)) (recur rest-xs (assoc acc :workflow a))
            :else (throw (ex-info (str "Unexpected argument: " a) {:arg a}))))))))

(def print-human-result package-cli/print-human-result)
(def aggregate package-cli/aggregate)

(defn lint-main [args]
  (let [opts (parse-lint-args args)
        fragment-packages (:fragment-packages opts)]
    (when (empty? fragment-packages)
      (binding [*out* *err*]
        (println "Usage: tesseraft fragment lint <fragment.edn>... [--format human|json|edn] [--strict]"))
      (System/exit 2))
    (let [results (mapv #(lint/lint-fragment-package-file % opts) fragment-packages)
          result (if (= 1 (count results)) (first results) (aggregate results))]
      (package-cli/print-lint-result! result (:format opts))
      (when-not (:ok result) (System/exit 1)))))

(defn sorted-outcomes [xs]
  (sort-by name (map parse-id xs)))

(defn explicit-transitions [declared routed next-id]
  (let [declared-set (set declared)
        unknown (seq (remove declared-set (keys routed)))
        missing (vec (remove #(contains? routed %) declared))]
    (when unknown
      (throw (ex-info (str "Unknown fragment outcome route(s): " (str/join ", " (map name unknown)))
                      {:outcomes (vec unknown)})))
    (when (and next-id (empty? missing))
      (throw (ex-info "--next is only valid when at least one declared outcome is not routed with --outcome" {:next next-id})))
    (when (and (nil? next-id) (seq missing))
      (throw (ex-info (str "Missing route(s) for fragment outcome(s): " (str/join ", " (map name missing)))
                      {:outcomes missing})))
    (vec (for [o declared
               :let [target (get routed o next-id)]]
           {:when {:fragment/outcome (name o)} :next target}))))

(defn fragment-node [pkg opts transitions]
  (cond-> {:type :fragment
           :fragment (spec/fragment-package-name pkg)
           :inputs (:inputs opts)
           :parameters (:parameters opts)
           :transitions transitions}
    (contains? opts :version) (assoc :version (:version opts))
    (contains? opts :scope) (assoc :scope (:scope opts))
    (contains? opts :prefix) (assoc :prefix (:prefix opts))))

(defn validate-targets! [states transitions]
  (doseq [[idx tr] (map-indexed vector transitions)]
    (when-not (contains? states (:next tr))
      (throw (ex-info (str "Transition target does not exist: " (:next tr)) {:index idx :next (:next tr)})))))

(defn asset-plan [pkg wf]
  (let [from-dir (spec/fragment-package-dir pkg)
        to-dir (spec/workflow-dir wf)
        wf-path (.normalize (.toAbsolutePath (fs/path (spec/workflow-file wf))))]
    (vec
      (for [[_ paths] (:assets pkg {})
            rel-path paths]
        (do
          (when-not (spec/safe-relative-path? rel-path)
            (throw (ex-info "Asset path is not a safe relative path" {:path rel-path})))
          (let [src (fs/path from-dir rel-path)
                dest (fs/path to-dir rel-path)
                dest-path (.normalize (.toAbsolutePath dest))]
            (when-not (fs/exists? src)
              (throw (ex-info "Referenced asset does not exist" {:path rel-path :source (str src)})))
            (when (= wf-path dest-path)
              (throw (ex-info "Refusing to overwrite workflow file with an asset" {:path rel-path})))
            (if (fs/exists? dest)
              (do
                (when-not (same-file-content? src dest)
                  (throw (ex-info "Refusing to overwrite different asset" {:path rel-path :destination (str dest)})))
                {:path rel-path :src src :dest dest :action :reuse})
              {:path rel-path :src src :dest dest :action :install})))))))

(def temp-sibling transaction/temp-sibling)
(def move-replace! transaction/move-replace!)
(def copy-new! transaction/copy-new!)
(def delete-empty-parents! transaction/delete-empty-parents!)
(def rollback! transaction/rollback!)
(def commit-transaction! transaction/commit!)
(def diagnostic-summary package-diagnostics/summary)

(defn import-main [args]
  (let [{:keys [fragment-package workflow as next] :as opts} (parse-import-args args)]
    (when (or (str/blank? fragment-package) (str/blank? workflow) (nil? as))
      (binding [*out* *err*]
        (println "Usage: tesseraft fragment import <fragment.edn> <workflow.edn> --as <state-id> --input name=EDN... [--parameter name=EDN...] (--outcome outcome=state... | --next state) [--version v] [--scope scope] [--prefix prefix]"))
      (System/exit 2))
    (let [package-lint (lint/lint-fragment-package-file fragment-package {:strict true})]
      (when-not (:ok package-lint)
        (throw (ex-info (str "Fragment package failed strict lint: " (diagnostic-summary package-lint)) package-lint))))
    (let [pkg (spec/read-fragment-package fragment-package)
          wf (spec/read-workflow workflow)
          states (:states wf)
          declared (sorted-outcomes (get-in pkg [:interface :outcomes]))
          transitions (explicit-transitions declared (:outcomes opts) next)]
      (when (contains? states as)
        (throw (ex-info "Workflow state already exists" {:state as :workflow workflow})))
      (validate-targets! states transitions)
      (let [node (fragment-node pkg opts transitions)
            wf* (assoc-in wf [:states as] node)
            candidate (dissoc wf* :__file :__dir)
            baseline-lint (lint/lint-workflow wf {:strict true})
            lint-result (lint/lint-workflow wf* {:strict true})
            pre-existing (set (:diagnostics baseline-lint))
            introduced (vec (remove pre-existing (:diagnostics lint-result)))
            introduced-blocking (filter #(contains? #{"error" "warning"} (:severity %)) introduced)
            plan (asset-plan pkg wf)]
        (when (seq introduced-blocking)
          (throw (ex-info (str "Fragment import would introduce a strict lint diagnostic: " (diagnostic-summary {:diagnostics introduced-blocking}))
                          {:result (assoc lint-result :diagnostics introduced-blocking)})))
        (commit-transaction! wf candidate plan)
        (println (str "Imported fragment " (spec/fragment-package-name pkg) " as " (name as)))
        (println (str "State: " (name as)))
        (println (str "Inputs: " (if (seq (:inputs opts)) (str/join ", " (map name (sort-by name (keys (:inputs opts))))) "none")))
        (println (str "Parameters: " (if (seq (:parameters opts)) (str/join ", " (map name (sort-by name (keys (:parameters opts))))) "none")))
        (println (str "Outcomes: " (str/join ", " (map (fn [tr] (str (get-in tr [:when :fragment/outcome]) "->" (name (:next tr)))) transitions))))))))

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
                (println "  import    Import a fragment package transactionally as a complete fragment boundary node")
                (println "  export    (deferred to P4.3) Extract a subgraph as a fragment package"))
              (System/exit 2))
        (throw (ex-info (str "Unknown fragment command: " cmd) {:command cmd}))))
    (catch Throwable t
      (binding [*out* *err*]
        (println (.getMessage t)))
      (System/exit 2))))
