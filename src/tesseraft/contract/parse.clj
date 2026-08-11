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
(defn read-data-file [data-file]
  (let [p (fs/absolutize data-file) ext (str/lower-case (str (fs/extension p))) text (slurp (str p))
        data (if (= "json" ext) (json/parse-string text true) (edn/read-string text))]
    (assoc data :__file (str p) :__dir (str (fs/parent p)))))
(def read-workflow read-data-file)
(def read-node-package read-data-file)
