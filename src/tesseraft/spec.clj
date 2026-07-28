(ns tesseraft.spec
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.edn :as edn]
    [clojure.string :as str]))

(def supported-api-versions #{"tesseraft.workflow/v1"})
(def supported-node-api-versions #{"tesseraft.node/v1"})
(def supported-fragment-api-versions #{"tesseraft.fragment/v1"})
(def supported-kind :workflow)
(def supported-node-kind :node)
(def supported-fragment-kind :fragment)
;; :fragment is a boundary-call node type used in workflows to include a
;; fragment package. It is linted as a boundary contract, not an inlined
;; subgraph; the internal proof is done once by lint-fragment-package.
(def valid-node-types #{:agent :deterministic :process :timer :approval :router :terminal :fragment})
(def known-effects #{:merge-issues :clear-issues :inc-round :inc-feedback-cycle :set-context :record-pr :fail-run})
(def base-pi-tools #{:read :bash :edit :write :grep :find :ls})
(def default-known-executors #{:pi-cli :pi-sdk :claude-code})
(def default-known-handlers
  #{:work-tracker/fetch-item :jira/fetch-ticket :git/ensure-branch :git/ensure-worktree :git/push :git/publish-visual-evidence :github/create-pr :github/fetch-pr-feedback :web/start-test-server :web/stop-test-server :web/capture-ui-evidence :web/validate-ui-review :notify/pinga :noop/succeed})
(def allowed-template-roots #{"inputs" "defaults" "run" "node" "artifacts" "workflow" "env"})
(def known-run-vars #{"id" "dir" "state" "round" "attempt" "feedback-cycle" "issues-file" "branch" "worktree-dir"})
(def resource-groups #{:requires :consumes :produces})
(def resource-fields #{:kind :name :path :mode :description :schema :source :tool :secret :handler :executor})
(def resource-modes #{:reusable :one-shot :read :write :read-write})

(defn keywordize-node-id [x]
  (cond
    (keyword? x) x
    (string? x) (keyword x)
    :else x))

(defn read-data-file [data-file]
  (let [p (fs/absolutize data-file)
        ext (str/lower-case (str (fs/extension p)))
        text (slurp (str p))
        data (if (#{"json"} ext)
               (json/parse-string text true)
               (edn/read-string text))]
    (assoc data :__file (str p) :__dir (str (fs/parent p)))))

(defn read-workflow [workflow-file]
  (read-data-file workflow-file))

(defn read-node-package [node-file]
  (read-data-file node-file))

(defn- semantic-keyword [x]
  (cond
    (keyword? x) x
    (and (string? x) (str/starts-with? x ":")) (keyword (subs x 1))
    (string? x) (keyword x)
    :else x))

(defn- semantic-keyword-coll [xs]
  (cond
    (set? xs) (set (map semantic-keyword xs))
    (vector? xs) (mapv semantic-keyword xs)
    (sequential? xs) (map semantic-keyword xs)
    :else xs))

(defn- normalize-fragment-interface [interface]
  (if-not (map? interface)
    interface
    (cond-> interface
      (contains? interface :outcomes)
      (update :outcomes (fn [xs]
                          (cond
                            (set? xs) (set (map semantic-keyword xs))
                            (sequential? xs) (set (map semantic-keyword xs))
                            :else xs))))))

(defn- normalize-fragment-transition [tr]
  (if-not (map? tr)
    tr
    (cond-> tr
      (contains? tr :next) (update :next keywordize-node-id)
      (contains? tr :effects) (update :effects semantic-keyword-coll)
      (contains? tr :when) (update :when (fn [w]
                                           (if (and (map? w) (contains? w :fragment/outcome))
                                             (update w :fragment/outcome semantic-keyword)
                                             w))))))

(defn- normalize-fragment-node [node]
  (if-not (map? node)
    node
    (cond-> node
      (contains? node :type) (update :type semantic-keyword)
      (contains? node :handler) (update :handler semantic-keyword)
      (contains? node :executor) (update :executor semantic-keyword)
      (contains? node :tools) (update :tools semantic-keyword-coll)
      (contains? node :status) (update :status semantic-keyword)
      (contains? node :outcome) (update :outcome (fn [x]
                                                   (if (sequential? x)
                                                     (set (map semantic-keyword x))
                                                     (semantic-keyword x))))
      (contains? node :next) (update :next keywordize-node-id)
      (contains? node :transitions) (update :transitions (fn [xs]
                                                           (if (sequential? xs)
                                                             (mapv normalize-fragment-transition xs)
                                                             xs))))))

(defn- normalize-fragment-states [states]
  (if-not (map? states)
    states
    (let [entries (map (fn [[id node]] [(keywordize-node-id id) (normalize-fragment-node node)]) states)
          normalized-ids (map first entries)]
      (if (= (count normalized-ids) (count (set normalized-ids)))
        (into {} entries)
        ;; Preserve a lint-visible malformed state instead of silently
        ;; overwriting semantically duplicate EDN ids such as :done and "done".
        (assoc (into {} (map (fn [[id node]] [id (normalize-fragment-node node)])) states)
               ::state-id-collision nil)))))

(defn- normalize-fragment-body [fragment]
  (if-not (map? fragment)
    fragment
    (cond-> fragment
      (contains? fragment :initial) (update :initial keywordize-node-id)
      (contains? fragment :entry) (update :entry (fn [entry]
                                                   (if-not (map? entry)
                                                     entry
                                                     (cond-> entry
                                                       (contains? entry :inputs) (update :inputs semantic-keyword-coll)
                                                       (contains? entry :parameters) (update :parameters semantic-keyword-coll)))))
      (contains? fragment :exit) (update :exit (fn [xs]
                                                 (if (sequential? xs)
                                                   (mapv (fn [e]
                                                           (if (map? e)
                                                             (cond-> e
                                                               (contains? e :on) (update :on semantic-keyword))
                                                             e))
                                                         xs)
                                                   xs)))
      (contains? fragment :states) (update :states normalize-fragment-states))))

(defn- normalize-fragment-requirements [requirements]
  (if-not (map? requirements)
    requirements
    (cond-> requirements
      (contains? requirements :executors) (update :executors semantic-keyword-coll)
      (contains? requirements :handlers) (update :handlers semantic-keyword-coll)
      (contains? requirements :tools) (update :tools semantic-keyword-coll))))

(defn normalize-fragment-package
  "Canonicalize fragment-only semantic positions after generic EDN/JSON parsing.
  Workflow and node package readers intentionally do not use this boundary."
  [pkg]
  (if-not (map? pkg)
    pkg
    (cond-> pkg
      (contains? pkg :kind) (update :kind semantic-keyword)
      (contains? pkg :interface) (update :interface normalize-fragment-interface)
      (contains? pkg :requirements) (update :requirements normalize-fragment-requirements)
      (contains? pkg :fragment) (update :fragment normalize-fragment-body))))

(defn read-fragment-package [fragment-file]
  (normalize-fragment-package (read-data-file fragment-file)))

(defn- portable-key [k]
  (cond
    (keyword? k) (if-let [ns (namespace k)] (str ns "/" (name k)) (name k))
    (string? k) k
    :else (str k)))

(defn- portable-fragment-value [x]
  (cond
    (keyword? x) (portable-key x)
    (set? x) (->> x (map portable-fragment-value) (sort-by pr-str) vec)
    (map? x) (into (sorted-map)
                   (map (fn [[k v]] [(portable-key k) (portable-fragment-value v)]))
                   x)
    (vector? x) (mapv portable-fragment-value x)
    (sequential? x) (mapv portable-fragment-value x)
    :else x))

(defn portable-fragment-package-data
  "Return deterministic JSON-compatible data for a normalized fragment package."
  [pkg]
  (portable-fragment-value (dissoc pkg :__file :__dir)))

(defn workflow-dir [wf] (:__dir wf "."))
(defn workflow-file [wf] (:__file wf))
(defn workflow-name [wf] (or (get-in wf [:metadata :name]) (:name wf)))
(defn node-package-dir [pkg] (:__dir pkg "."))
(defn node-package-file [pkg] (:__file pkg))
(defn node-package-name [pkg] (get-in pkg [:metadata :name]))
(defn fragment-package-dir [pkg] (:__dir pkg "."))
(defn fragment-package-file [pkg] (:__file pkg))
(defn fragment-package-name [pkg] (get-in pkg [:metadata :name]))
(defn resolve-fragment-package-path [pkg p]
  (when p (str (fs/path (fragment-package-dir pkg) p))))
(defn node-ids [wf] (set (keys (:states wf))))
(defn node [wf id] (get-in wf [:states id]))
(defn terminal-node? [[_ n]] (= :terminal (:type n)))
(defn terminal-ids [wf] (set (map first (filter terminal-node? (:states wf)))))

(defn transitions [node]
  (cond
    (:transitions node) (:transitions node)
    (:next node) [{:when {:else true} :next (:next node)}]
    :else []))

(defn transition-targets [node]
  (->> (transitions node) (map :next) (remove nil?) set))

(defn graph [wf]
  (into {} (for [[id n] (:states wf)] [id (transition-targets n)])))

(defn reachable-states [wf]
  (let [g (graph wf)]
    (loop [seen #{} stack [(:initial wf)]]
      (if-let [s (peek stack)]
        (if (or (nil? s) (seen s))
          (recur seen (pop stack))
          (recur (conj seen s) (into (pop stack) (get g s))))
        seen))))

(defn output-contracts [node] (:outputs node {}))
(defn output-path [contract]
  (cond
    (string? contract) contract
    (map? contract) (:path contract)
    :else nil))
(defn output-schema [contract]
  (when (map? contract) (:schema contract)))
(defn output-required? [contract]
  (cond
    (string? contract) true
    (map? contract) (not= false (:required contract))
    :else false))
(defn outputs-with-paths [node]
  (into {} (keep (fn [[k v]] (when-let [p (output-path v)] [k p]))) (output-contracts node)))
(defn status-output-path [node]
  (or (:status-path node) (output-path (get-in node [:outputs :status]))))
(defn required-output-paths [node]
  (->> (output-contracts node)
       (keep (fn [[_ v]] (when (output-required? v) (output-path v))))
       (remove str/blank?) vec))

(defn resolve-workflow-path [wf p]
  (when p (str (fs/path (workflow-dir wf) p))))
(defn resolve-node-package-path [pkg p]
  (when p (str (fs/path (node-package-dir pkg) p))))
(defn absolute-path? [s] (and (string? s) (str/starts-with? s "/")))
(defn contains-parent-segment? [s]
  (some #{".."} (str/split (str s) #"/")))
(defn safe-relative-path? [s]
  (and (string? s)
       (not (str/blank? s))
       (not (absolute-path? s))
       (not (contains-parent-segment? s))))

(defn template-vars [s]
  (when (string? s)
    (->> (re-seq #"\{\{\s*([^}\s]+)\s*\}\}" s) (map second) set)))

(defn data-strings [x]
  (cond
    (string? x) [x]
    (map? x) (mapcat (fn [[k v]] (concat (data-strings k) (data-strings v))) x)
    (sequential? x) (mapcat data-strings x)
    :else []))

(defn workflow-template-vars [wf]
  (set (mapcat template-vars (data-strings (dissoc wf :__file :__dir)))))

(defn prompt-template-vars [wf path]
  (let [p (resolve-workflow-path wf path)]
    (when (and p (fs/exists? p))
      (template-vars (slurp p)))))

(defn context-value [ctx var-name]
  (let [parts (str/split var-name #"\.")]
    (get-in ctx (map keyword parts))))

(defn render-template-string [s ctx]
  (if-not (string? s)
    s
    (str/replace s #"\{\{\s*([^}\s]+)\s*\}\}"
                 (fn [[_ var-name]] (str (or (context-value ctx var-name) ""))))))

(defn render-data [x ctx]
  (cond
    (string? x) (render-template-string x ctx)
    (map? x) (into (empty x) (map (fn [[k v]] [k (render-data v ctx)]) x))
    (vector? x) (mapv #(render-data % ctx) x)
    (seq? x) (map #(render-data % ctx) x)
    :else x))

(defn normalize-id [x]
  (if (keyword? x) (name x) (str x)))

(defn normalized-graph [wf]
  (into []
        (for [[id targets] (graph wf)]
          {:id (normalize-id id) :targets (vec (map normalize-id targets))})))

(defn mermaid [wf]
  (let [lines (concat ["flowchart TD"]
                      (for [[id node] (:states wf)]
                        (str "  " (name id) "[\"" (or (:title node) (name id)) "\"]"))
                      (for [[id targets] (graph wf)
                            target targets]
                        (str "  " (name id) " --> " (name target))))]
    (str (str/join "\n" lines) "\n")))
