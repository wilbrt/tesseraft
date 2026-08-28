(ns tesseraft.node.cli
  (:require
    [tesseraft.cli-args :as cli-args]
    [tesseraft.lint.core :as lint]
    [tesseraft.package.cli :as package-cli]
    [tesseraft.package.fs :as package-fs]
    [tesseraft.persistence.safe-write :as safe-write]
    [tesseraft.spec :as spec]
    [babashka.fs :as fs]
    [clojure.pprint :as pprint]
    [clojure.string :as str]))

(def parse-id package-cli/parse-id)

(defn write-edn! [path data]
  (safe-write/write-text! path (with-out-str (pprint/pprint data)))
  path)

(def path-like-command? package-fs/path-like-command?)

(defn output-schema-paths [node]
  (->> (spec/output-contracts node)
       (keep (fn [[_ contract]] (spec/output-schema contract)))
       vec))

(defn export-assets [node]
  (cond-> {}
    (or (:prompt-template node)
        (get-in node [:session :continuation-prompt-template]))
    (assoc :prompts (vec (remove nil? [(:prompt-template node)
                                       (get-in node [:session :continuation-prompt-template])])))

    (and (= :process (:type node)) (path-like-command? (first (:command node))))
    (assoc :scripts [(first (:command node))])

    (seq (output-schema-paths node))
    (assoc :schemas (output-schema-paths node))))

(def same-file-content? package-fs/same-file-content?)
(def copy-asset! package-fs/copy-asset!)
(def copy-assets! package-fs/copy-assets!)

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
  (package-cli/parse-lint-args args :node-packages))

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

(def print-human-result package-cli/print-human-result)
(def aggregate package-cli/aggregate)

(defn lint-main [args]
  (let [opts (parse-lint-args args)
        node-packages (:node-packages opts)]
    (when (empty? node-packages)
      (binding [*out* *err*]
        (println "Usage: tesseraft node lint <node.edn>... [--format human|json|edn] [--strict]"))
      (System/exit 2))
    (let [results (mapv #(lint/lint-node-package-file % opts) node-packages)
          result (if (= 1 (count results)) (first results) (aggregate results))]
      (package-cli/print-lint-result! result (:format opts))
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
