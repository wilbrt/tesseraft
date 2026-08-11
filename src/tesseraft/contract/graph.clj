(ns tesseraft.contract.graph
  (:require [clojure.string :as str]))

(defn node-ids [wf] (set (keys (:states wf))))
(defn node [wf id] (get-in wf [:states id]))
(defn terminal-node? [[_ n]] (= :terminal (:type n)))
(defn terminal-ids [wf] (set (map first (filter terminal-node? (:states wf)))))
(defn transitions [node] (cond (:transitions node) (:transitions node) (:next node) [{:when {:else true} :next (:next node)}] :else []))
(defn outcome-name [x] (cond (keyword? x) (name x) (string? x) x (nil? x) nil :else (str x)))
(defn match-transition? [result transition]
  (let [pred (:when transition)]
    (or (= true (:else pred))
        (every? (fn [[k v]] (if (= k :fragment/outcome) (= (outcome-name v) (outcome-name (get result k))) (= v (get result k)))) pred))))
(defn transition-targets [node] (->> (transitions node) (map :next) (remove nil?) set))
(defn graph [wf] (into {} (for [[id n] (:states wf)] [id (transition-targets n)])))
(defn reachable-states [wf]
  (let [g (graph wf)] (loop [seen #{} stack [(:initial wf)]] (if-let [s (peek stack)] (if (or (nil? s) (seen s)) (recur seen (pop stack)) (recur (conj seen s) (into (pop stack) (get g s)))) seen))))
(defn output-contracts [node] (:outputs node {}))
(defn output-path [contract] (cond (string? contract) contract (map? contract) (:path contract) :else nil))
(defn output-schema [contract] (when (map? contract) (:schema contract)))
(defn output-required? [contract] (cond (string? contract) true (map? contract) (not= false (:required contract)) :else false))
(defn outputs-with-paths [node] (into {} (keep (fn [[k v]] (when-let [p (output-path v)] [k p]))) (output-contracts node)))
(defn status-output-path [node] (or (:status-path node) (output-path (get-in node [:outputs :status]))))
(defn required-output-paths [node] (->> (output-contracts node) (keep (fn [[_ v]] (when (output-required? v) (output-path v)))) (remove str/blank?) vec))
(defn normalize-id [x] (if (keyword? x) (name x) (str x)))
(defn normalized-graph [wf] (into [] (for [[id targets] (graph wf)] {:id (normalize-id id) :targets (vec (map normalize-id targets))})))
(defn mermaid [wf]
  (let [lines (concat ["flowchart TD"] (for [[id node] (:states wf)] (str "  " (name id) "[\"" (or (:title node) (name id)) "\"]")) (for [[id targets] (graph wf) target targets] (str "  " (name id) " --> " (name target))))]
    (str (str/join "\n" lines) "\n")))
