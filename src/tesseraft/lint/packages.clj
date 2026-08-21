(ns tesseraft.lint.packages
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [tesseraft.capabilities.executors :as executor-catalog]
            [tesseraft.lint.diagnostics :refer [err warn]]
            [tesseraft.lint.nodes :as nodes]
            [tesseraft.lint.resources :as resources]
            [tesseraft.spec :as spec]))

(def known-executors nodes/known-executors)
(def known-handlers nodes/known-handlers)
(def allowed-tools nodes/allowed-tools)
(def optional-nonblank-string-check nodes/optional-nonblank-string-check)
(def agent-thinking-check nodes/agent-thinking-check)
(def path-contract-checks nodes/path-contract-checks)
(def resource-declaration-checks resources/resource-declaration-checks)

(defn node-package-top-level-checks [pkg]
  (let [required [:api-version :kind :metadata :node]]
    (concat
      (for [k required :when (not (contains? pkg k))]
        (err :missing-top-level-key [k] (str "Missing required top-level key " k)))
      (when (and (:api-version pkg) (not (contains? spec/supported-node-api-versions (:api-version pkg))))
        [(err :unsupported-api-version [:api-version]
              (str "Unsupported api-version " (pr-str (:api-version pkg))))])
      (when (and (:kind pkg) (not= spec/supported-node-kind (:kind pkg)))
        [(err :unsupported-kind [:kind] (str "Unsupported kind " (pr-str (:kind pkg))))])
      (when (and (:metadata pkg) (not (map? (:metadata pkg))))
        [(err :metadata-not-map [:metadata] ":metadata must be a map")])
      (when (and (map? (:metadata pkg)) (str/blank? (str (get-in pkg [:metadata :name]))))
        [(err :metadata-missing-name [:metadata :name] "Node package metadata must include :name")])
      (when (and (:node pkg) (not (map? (:node pkg))))
        [(err :node-not-map [:node] ":node must be a map")]))))

(defn asset-paths [pkg]
  (for [[asset-kind paths] (:assets pkg {})
        :when (sequential? paths)
        path paths]
    [asset-kind path]))

(defn declared-asset-paths [pkg]
  (set (map second (asset-paths pkg))))

(defn path-like-command? [cmd]
  (and (string? cmd) (or (str/includes? cmd "/") (str/starts-with? cmd "."))))

(defn node-referenced-assets [node]
  (set (remove nil?
               (concat
                 [(:prompt-template node)]
                 (when-let [cmd (first (:command node))]
                   (when (path-like-command? cmd) [cmd]))
                 (keep (fn [[_ contract]] (spec/output-schema contract))
                       (spec/output-contracts node))))))

(defn node-package-asset-checks [pkg]
  (let [declared (declared-asset-paths pkg)
        referenced (node-referenced-assets (:node pkg))]
    (concat
      (apply concat
             (for [[asset-kind path] (asset-paths pkg)]
               (concat
                 (when-not (spec/safe-relative-path? path)
                   [(err :invalid-asset-path [:assets asset-kind]
                         (str "Asset paths must be safe relative paths: " path))])
                 (when (and (spec/safe-relative-path? path)
                            (not (fs/exists? (spec/resolve-node-package-path pkg path))))
                   [(err :asset-missing [:assets asset-kind]
                         (str "Declared asset does not exist: " path))]))))
      (for [path referenced
            :when (and path (not (contains? declared path)))]
        (warn :referenced-asset-not-declared [:assets]
              (str "Node references an asset that is not declared in :assets: " path))))))

(defn node-package-node-checks [pkg opts]
  (let [node (:node pkg)
        t (:type node)]
    (when (map? node)
      (concat
        (when-not t [(err :missing-node-type [:node :type] "Node is missing :type")])
        (when (and t (not (contains? spec/valid-node-types t)))
          [(err :unknown-node-type [:node :type] (str "Unknown node type " t))])
        (path-contract-checks pkg :node node)
        (case t
          :agent
          (concat
            (when-not (:executor node)
              [(err :agent-missing-executor [:node :executor]
                    "Agent node must declare :executor")])
            (when (and (:executor node) (not (contains? (known-executors opts) (:executor node))))
              [(err :unknown-executor [:node :executor]
                    (str "Unknown agent executor: " (:executor node)))])
            (when (and (:executor node)
                       (contains? (executor-catalog/ids) (:executor node))
                       (not (executor-catalog/dispatchable? (:executor node))))
              [(err :executor-unavailable [:node :executor]
                    (str "Agent executor is recognized but unavailable: " (:executor node)))])
            (optional-nonblank-string-check :invalid-agent-provider [:node :provider] ":provider" (:provider node))
            (optional-nonblank-string-check :invalid-agent-model [:node :model] ":model" (:model node))
            (nodes/opencode-model-check [:node] node)
            (agent-thinking-check [:node :thinking] (:thinking node))
            (when-not (:prompt-template node)
              [(err :agent-missing-prompt-template [:node :prompt-template]
                    "Agent node must declare :prompt-template")])
            (when (:prompt-template node)
              (let [p (spec/resolve-node-package-path pkg (:prompt-template node))]
                (when-not (fs/exists? p)
                  [(err :prompt-template-missing [:node :prompt-template]
                        (str "Prompt template file does not exist: " (:prompt-template node)))])))
            (when-not (spec/status-output-path node)
              [(err :agent-missing-status-output [:node :outputs :status]
                    "Agent node must declare a status output")])
            (for [tool (:tools node)
                  :when (not (contains? (allowed-tools pkg opts) tool))]
              (warn :unknown-agent-tool [:node :tools]
                    (str "Tool is not in the configured allowed tool set: " tool))))

          :deterministic
          (concat
            (when-not (:handler node)
              [(err :deterministic-missing-handler [:node :handler]
                    "Deterministic node must declare :handler")])
            (when (and (:handler node) (not (contains? (known-handlers opts) (:handler node))))
              [(err :unknown-handler [:node :handler]
                    (str "Unknown deterministic handler: " (:handler node)))]))

          :process
          (concat
            (when-not (seq (:command node))
              [(err :process-missing-command [:node :command]
                    "Process node must declare non-empty :command")])
            (when-let [cmd0 (first (:command node))]
              (when (path-like-command? cmd0)
                (let [p (spec/resolve-node-package-path pkg cmd0)]
                  (when-not (fs/exists? p)
                    [(err :process-command-missing [:node :command 0]
                          (str "Process command file does not exist: " cmd0))])))))

          :timer
          (when-not (:duration node)
            [(err :timer-missing-duration [:node :duration]
                  "Timer node must declare :duration")])

          :approval
          (when-not (:message node)
            [(err :approval-missing-message [:node :message]
                  "Approval node must declare :message")])

          :router []
          :terminal []
          [])))))

(defn node-package-template-var-checks [pkg]
  (let [node (:node pkg)
        pkg-vars (spec/workflow-template-vars pkg)
        prompt-vars (when (:prompt-template node)
                      (spec/prompt-template-vars pkg (:prompt-template node)))
        all-vars (set (concat pkg-vars prompt-vars))]
    (for [v all-vars
          :let [[root field] (str/split v #"\." 2)]
          :when (or (not (contains? spec/allowed-template-roots root))
                    (and (= root "run") field (not (contains? spec/known-run-vars field))))]
      (if (contains? spec/allowed-template-roots root)
        (warn :unknown-run-template-var [:templates]
              (str "Template references unknown run field {{" v "}}"))
        (err :unknown-template-root [:templates]
             (str "Unknown template variable namespace in {{" v "}}"))))))

(defn node-package-resource-checks [pkg]
  (concat
    (resource-declaration-checks [:requirements :resources] (get-in pkg [:requirements :resources]))
    (resource-declaration-checks [:node :resources] (get-in pkg [:node :resources]))))

(defn lint-node-package
  ([pkg] (lint-node-package pkg {}))
  ([pkg opts]
   (let [diagnostics (vec (remove nil?
                                  (concat
                                    (node-package-top-level-checks pkg)
                                    (node-package-node-checks pkg opts)
                                    (node-package-resource-checks pkg)
                                    (node-package-asset-checks pkg)
                                    (node-package-template-var-checks pkg))))
         strict? (:strict opts)
         errors (filter #(or (= "error" (:severity %))
                             (and strict? (= "warning" (:severity %)))) diagnostics)
         warnings (filter #(= "warning" (:severity %)) diagnostics)]
     {:ok (empty? errors)
      :node-package (spec/node-package-file pkg)
      :errors (vec errors)
      :warnings (vec warnings)
      :diagnostics diagnostics})))

(defn lint-node-package-file
  ([node-file] (lint-node-package-file node-file {}))
  ([node-file opts]
   (try
     (let [pkg (spec/read-node-package node-file)]
       (lint-node-package pkg opts))
     (catch Throwable t
       {:ok false
        :node-package (str node-file)
        :errors [(err :parse-error [] (.getMessage t))]
        :warnings []
        :diagnostics [(err :parse-error [] (.getMessage t))]}))))

;; ============================================================
;; Fragment package lint (tesseraft.fragment/v1)
;; ============================================================
;; A fragment package owns an internal subgraph (:fragment :states) and a
;; boundary contract (:interface). lint-fragment-package validates the
;; package once; inclusion in a workflow lints only the boundary (see
;; fragment-node-diagnostics above).
