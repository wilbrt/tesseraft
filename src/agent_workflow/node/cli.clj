(ns agent-workflow.node.cli
  (:require
    [agent-workflow.cli-args :as cli-args]
    [agent-workflow.lint.core :as lint]
    [agent-workflow.spec :as spec]
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

(defn path-like-command? [cmd]
  (and (string? cmd) (or (str/includes? cmd "/") (str/starts-with? cmd "."))))

(defn output-schema-paths [node]
  (->> (spec/output-contracts node)
       (keep (fn [[_ contract]] (spec/output-schema contract)))
       vec))

(defn export-assets [node]
  (cond-> {}
    (:prompt-template node)
    (assoc :prompts [(:prompt-template node)])

    (and (= :process (:type node)) (path-like-command? (first (:command node))))
    (assoc :scripts [(first (:command node))])

    (seq (output-schema-paths node))
    (assoc :schemas (output-schema-paths node))))

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

(defn exported-node-package [wf state-id node]
  (let [node-name (str (spec/workflow-name wf) "-" (name state-id))
        node* (dissoc node :next :transitions)]
    {:api-version "tesseraft.node/v1"
     :kind :node
     :metadata (cond-> {:name node-name}
                 (:title node) (assoc :title (:title node))
                 true (assoc :description (str "Exported from workflow " (spec/workflow-name wf)
                                               " state " (name state-id))))
     :assets (export-assets node*)
     :node node*}))

(defn parse-lint-args [args]
  (loop [xs args acc {:node-packages [] :format "human"}]
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
          (recur rest-xs (update acc :node-packages conj a)))))))

(defn parse-export-args [args]
  (loop [xs args acc {}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs
            rest-xs (rest xs)]
        (case a
          "--out" (recur more (assoc acc :out (cli-args/require-value a b)))
          (cond
            (nil? (:workflow acc)) (recur rest-xs (assoc acc :workflow a))
            (nil? (:state-id acc)) (recur rest-xs (assoc acc :state-id (parse-id a)))
            :else (throw (ex-info (str "Unexpected argument: " a) {:arg a}))))))))

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
            (nil? (:node-package acc)) (recur rest-xs (assoc acc :node-package a))
            (nil? (:workflow acc)) (recur rest-xs (assoc acc :workflow a))
            :else (throw (ex-info (str "Unexpected argument: " a) {:arg a}))))))))

(defn print-human-result [result]
  (println (if (:ok result) "OK" "FAILED") (:node-package result))
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
        node-packages (:node-packages opts)]
    (when (empty? node-packages)
      (binding [*out* *err*]
        (println "Usage: tesseraft node lint <node.edn>... [--format human|json|edn] [--strict]"))
      (System/exit 2))
    (let [results (mapv #(lint/lint-node-package-file % opts) node-packages)
          result (if (= 1 (count results)) (first results) (aggregate results))]
      (case (:format opts)
        "json" (println (json/generate-string result {:pretty true}))
        "edn" (prn result)
        "human" (if (:files result)
                  (doseq [r (:files result)] (print-human-result r))
                  (print-human-result result))
        (print-human-result result))
      (when-not (:ok result) (System/exit 1)))))

(defn export-main [args]
  (let [{:keys [workflow state-id out]} (parse-export-args args)]
    (when (or (str/blank? workflow) (nil? state-id) (str/blank? out))
      (binding [*out* *err*]
        (println "Usage: tesseraft node export <workflow.edn> <state-id> --out <dir>"))
      (System/exit 2))
    (let [wf (spec/read-workflow workflow)
          node (spec/node wf state-id)]
      (when-not node
        (throw (ex-info "Workflow state does not exist" {:state state-id :workflow workflow})))
      (let [out-dir (fs/absolutize out)
            package (exported-node-package wf state-id node)]
        (fs/create-dirs out-dir)
        (copy-assets! (spec/workflow-dir wf) out-dir (:assets package))
        (write-edn! (fs/path out-dir "node.edn") package)
        (let [result (lint/lint-node-package-file (str (fs/path out-dir "node.edn")))]
          (when-not (:ok result)
            (throw (ex-info "Exported node package failed lint" result))))
        (println (str (fs/path out-dir "node.edn")))))))

(defn routable-node? [node]
  (or (= :terminal (:type node)) (:next node) (:transitions node)))

(defn node-with-import-route [node next-id]
  (cond
    (routable-node? node) node
    next-id (assoc node :next next-id)
    :else (throw (ex-info "Imported non-terminal node needs --next because package node has no route"
                          {:node-type (:type node)}))))

(defn import-main [args]
  (let [{:keys [node-package workflow as next]} (parse-import-args args)]
    (when (or (str/blank? node-package) (str/blank? workflow) (nil? as))
      (binding [*out* *err*]
        (println "Usage: tesseraft node import <node.edn> <workflow.edn> --as <state-id> [--next <state-id>]"))
      (System/exit 2))
    (let [lint-result (lint/lint-node-package-file node-package)]
      (when-not (:ok lint-result)
        (throw (ex-info "Node package failed lint" lint-result))))
    (let [pkg (spec/read-node-package node-package)
          wf (spec/read-workflow workflow)
          states (:states wf)]
      (when (contains? states as)
        (throw (ex-info "Workflow state already exists" {:state as :workflow workflow})))
      (when (and next (not (contains? states next)))
        (throw (ex-info "--next target does not exist in workflow" {:next next :workflow workflow})))
      (copy-assets! (spec/node-package-dir pkg) (spec/workflow-dir wf) (:assets pkg))
      (let [node (node-with-import-route (:node pkg) next)
            wf* (assoc-in wf [:states as] node)
            result (lint/lint-workflow wf*)]
        (when-not (:ok result)
          (throw (ex-info "Workflow would fail lint after node import" result)))
        (write-edn! (spec/workflow-file wf) (dissoc wf* :__file :__dir))
        (println (str "Imported " (spec/node-package-name pkg) " as " (name as)))))))

(defn -main [& args]
  (try
    (let [[cmd & more] args]
      (case cmd
        "lint" (lint-main more)
        "export" (export-main more)
        "import" (import-main more)
        nil (do
              (binding [*out* *err*]
                (println "Usage: tesseraft node <command> [args]")
                (println)
                (println "Commands:")
                (println "  lint      Validate self-contained node packages")
                (println "  export    Export a workflow state as a self-contained node package")
                (println "  import    Import a self-contained node package into a workflow"))
              (System/exit 2))
        (throw (ex-info (str "Unknown node command: " cmd) {:command cmd}))))
    (catch Throwable t
      (binding [*out* *err*]
        (println (.getMessage t)))
      (System/exit 2))))
