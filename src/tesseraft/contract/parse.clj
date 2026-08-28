(ns tesseraft.contract.parse
  (:require [babashka.fs :as fs]
            [cheshire.core :as json]
            [clojure.edn :as edn]
            [clojure.string :as str]))

(def supported-api-versions #{"tesseraft.workflow/v1"})
(def supported-node-api-versions #{"tesseraft.node/v1"})
(def supported-fragment-api-versions #{"tesseraft.fragment/v1"})
(def supported-kind :workflow)
(def supported-node-kind :node)
(def supported-fragment-kind :fragment)
(def valid-node-types #{:agent :deterministic :process :timer :approval :router :terminal :fragment})
(def known-effects #{:merge-issues :clear-issues :inc-round :inc-feedback-cycle :set-context :record-pr :fail-run})
(def base-pi-tools #{:read :bash :edit :write :grep :find :ls})
(def allowed-template-roots #{"inputs" "defaults" "run" "node" "artifacts" "workflow" "env"})
(def known-run-vars #{"id" "dir" "state" "round" "attempt" "feedback-cycle" "issues-file" "branch" "worktree-dir"})
(def resource-groups #{:requires :consumes :produces})
(def resource-fields #{:kind :name :path :mode :description :schema :source :tool :secret :handler :executor})
(def resource-modes #{:reusable :one-shot :read :write :read-write})

(defn keywordize-node-id [x] (cond (keyword? x) x (string? x) (keyword x) :else x))
(defn semantic-keyword [x]
  (cond
    (keyword? x) x
    (and (string? x) (str/starts-with? x ":")) (keyword (subs x 1))
    (string? x) (keyword x)
    :else x))
(defn semantic-keywords [xs]
  (cond
    (set? xs) (set (map semantic-keyword xs))
    (vector? xs) (mapv semantic-keyword xs)
    (sequential? xs) (map semantic-keyword xs)
    :else xs))

(defn normalize-session [session]
  (if-not (map? session)
    session
    (cond-> session
      (contains? session :mode) (update :mode semantic-keyword))))

(defn normalize-transition [transition]
  (if-not (map? transition)
    transition
    (cond-> transition
      (contains? transition :next) (update :next keywordize-node-id)
      (contains? transition :effects) (update :effects semantic-keywords)
      (contains? transition :when)
      (update :when
              #(if (and (map? %) (contains? % :fragment/outcome))
                 (update % :fragment/outcome semantic-keyword)
                 %)))))

(defn normalize-node [node]
  (if-not (map? node)
    node
    (cond-> node
      (contains? node :type) (update :type semantic-keyword)
      (contains? node :handler) (update :handler semantic-keyword)
      (contains? node :executor) (update :executor semantic-keyword)
      (contains? node :tools) (update :tools semantic-keywords)
      (contains? node :session) (update :session normalize-session)
      (contains? node :status) (update :status semantic-keyword)
      (contains? node :outcome)
      (update :outcome #(if (sequential? %)
                          (set (map semantic-keyword %))
                          (semantic-keyword %)))
      (contains? node :next) (update :next keywordize-node-id)
      (contains? node :transitions)
      (update :transitions #(if (sequential? %) (mapv normalize-transition %) %)))))

(defn normalize-states [states]
  (if-not (map? states)
    states
    (let [entries (map (fn [[id node]] [(keywordize-node-id id) (normalize-node node)]) states)
          ids (map first entries)]
      (if (= (count ids) (count (set ids)))
        (into {} entries)
        (assoc (into {} (map (fn [[id node]] [id (normalize-node node)])) states)
               ::state-id-collision nil)))))

(defn normalize-requirements [requirements]
  (if-not (map? requirements)
    requirements
    (cond-> requirements
      (contains? requirements :executors) (update :executors semantic-keywords)
      (contains? requirements :handlers) (update :handlers semantic-keywords)
      (contains? requirements :tools) (update :tools semantic-keywords))))

(defn normalize-policies [policies]
  (if-not (map? policies)
    policies
    (cond-> policies
      (contains? policies :allowed-agent-tools)
      (update :allowed-agent-tools semantic-keywords))))

(defn normalize-workflow [workflow]
  (if-not (map? workflow)
    workflow
    (cond-> workflow
      (contains? workflow :kind) (update :kind semantic-keyword)
      (contains? workflow :initial) (update :initial keywordize-node-id)
      (contains? workflow :states) (update :states normalize-states)
      (contains? workflow :policies) (update :policies normalize-policies))))

(defn normalize-node-package [pkg]
  (if-not (map? pkg)
    pkg
    (cond-> pkg
      (contains? pkg :kind) (update :kind semantic-keyword)
      (contains? pkg :requirements) (update :requirements normalize-requirements)
      (contains? pkg :node) (update :node normalize-node))))

(defn read-data-file [data-file]
  (let [p (fs/absolutize data-file) ext (str/lower-case (str (fs/extension p))) text (slurp (str p))
        data (if (= "json" ext) (json/parse-string text true) (edn/read-string text))]
    (assoc data :__file (str p) :__dir (str (fs/parent p)))))
(defn read-workflow [data-file] (normalize-workflow (read-data-file data-file)))
(defn read-node-package [data-file] (normalize-node-package (read-data-file data-file)))
