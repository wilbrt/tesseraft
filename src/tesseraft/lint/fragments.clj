(ns tesseraft.lint.fragments
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [tesseraft.lint.diagnostics :refer [err warn]]
            [tesseraft.lint.graph :as graph]
            [tesseraft.lint.nodes :as nodes]
            [tesseraft.lint.packages :as packages]
            [tesseraft.lint.resources :as resources]
            [tesseraft.lint.templates :as templates]
            [tesseraft.spec :as spec]))

(def path-contract-checks nodes/path-contract-checks)
(def node-type-checks nodes/node-type-checks)
(def transition-checks nodes/transition-checks)
(def reachability-checks nodes/reachability-checks)
(def node-contract-checks nodes/node-contract-checks)
(def duplicate-output-checks graph/duplicate-output-checks)
(def cycle-checks graph/cycle-checks)
(def normalize-resource-value resources/normalize-resource-value)
(def workflow-resource-checks resources/workflow-resource-checks)
(def resource-declaration-checks resources/resource-declaration-checks)
(def template-var-checks templates/checks)
(def asset-paths packages/asset-paths)
(def declared-asset-paths packages/declared-asset-paths)
(def path-like-command? packages/path-like-command?)

(declare lint-fragment-package lint-fragment-package-cached)

(defn fragment-home-dir []
  (or (System/getenv "TESSERAFT_HOME")
      (str (fs/path (System/getProperty "user.home") ".tesseraft"))))

(defn ancestor-dirs [start]
  (loop [d (fs/absolutize (fs/path (str start))) acc []]
    (let [s (str d)
          p (some-> (fs/parent d) str)]
      (cond
        (nil? p) (conj acc s)
        (= p s) (conj acc s)
        (some #{s} acc) acc
        :else (recur (fs/path p) (conj acc s))))))

(def fragment-scopes [:project :global :examples])
(def fragment-scope-aliases {:project :project "project" :project
                             :global :global "global" :global
                             :example :examples "example" :examples
                             :examples :examples "examples" :examples
                             :configured :examples "configured" :examples})
(def fragment-scalar-types #{:string :integer :number :boolean})

(defn normalize-fragment-name-key [x]
  (cond
    (keyword? x) x
    (and (string? x) (str/starts-with? x ":")) (keyword (subs x 1))
    (string? x) (keyword x)
    :else x))

(defn normalize-fragment-scope [scope]
  (cond
    (nil? scope) nil
    (contains? fragment-scope-aliases scope) (get fragment-scope-aliases scope)
    (keyword? scope) (get fragment-scope-aliases (name scope))
    (string? scope) (get fragment-scope-aliases scope)
    :else nil))

(defn safe-fragment-package-name? [name]
  (and (string? name)
       (not (str/blank? name))
       (not (str/includes? name "/"))
       (not (str/includes? name "\\"))
       (not (#{"." ".."} name))
       (not (spec/portable-absolute-path? name))
       (not (spec/windows-drive-qualified-path? name))))

(defn- path-beneath? [root child]
  (let [root-path (.normalize (.toAbsolutePath (fs/path root)))
        child-path (.normalize (.toAbsolutePath (fs/path child)))]
    (.startsWith child-path root-path)))

(defn- fragment-candidate [scope root name]
  (let [path (str (fs/path root name "fragment.edn"))]
    (when (path-beneath? root path)
      {:scope scope :root (str (fs/path root)) :path path})))

(defn fragment-package-candidates [wf name]
  (let [home (fragment-home-dir)
        ancs (ancestor-dirs (or (spec/workflow-dir wf) "."))]
    (vec (keep identity
               (concat
                 (for [d ancs]
                   (fragment-candidate :project (fs/path d ".tesseraft" "fragments") name))
                 [(fragment-candidate :global (fs/path home "fragments") name)]
                 (for [d ancs]
                   (fragment-candidate :examples (fs/path d "examples" "catalog" "fragments") name)))))))

(defn resolve-fragment-package [wf node]
  (let [name (:fragment node)
        explicit? (contains? node :scope)
        scope (normalize-fragment-scope (:scope node))]
    (cond
      (not (safe-fragment-package-name? name))
      {:error :invalid-name :name name :explicit-scope? explicit?}

      (and explicit? (nil? scope))
      {:error :invalid-scope}

      :else
      (let [candidates (cond->> (fragment-package-candidates wf name)
                         scope (filter #(= scope (:scope %))))
            found (first (filter #(fs/exists? (:path %)) candidates))]
        (if found
          (assoc found :name name :explicit-scope? explicit?)
          {:error :not-found :name name :scope scope :explicit-scope? explicit?})))))

(defn find-fragment-package-file [wf node]
  (let [res (resolve-fragment-package wf node)]
    (when (:path res) (:path res))))

(defn fragment-transition-outcome [tr]
  (let [outcome (get-in tr [:when :fragment/outcome])]
    (cond
      (keyword? outcome) (name outcome)
      (string? outcome) outcome
      (nil? outcome) nil
      :else (str outcome))))

(defn fragment-node-output-required? [contract]
  (cond
    (string? contract) false
    (map? contract) (not= false (:required contract))
    :else false))

(defn valid-fragment-name-key? [x]
  (cond
    (keyword? x) (not (str/blank? (name x)))
    (and (string? x) (str/starts-with? x ":")) (not (str/blank? (subs x 1)))
    (string? x) (not (str/blank? x))
    :else false))

(defn normalized-fragment-map [m]
  (when (map? m)
    (let [pairs (map (fn [[k v]] [(normalize-fragment-name-key k) k v]) m)
          valid-pairs (filter (fn [[_ original _]] (valid-fragment-name-key? original)) pairs)
          invalid-keys (mapv second (remove (fn [[_ original _]] (valid-fragment-name-key? original)) pairs))
          collisions (->> valid-pairs (group-by first) (filter (fn [[_ xs]] (< 1 (count xs)))))]
      {:map (into {} (map (fn [[k _ v]] [k v]) valid-pairs))
       :invalid-keys invalid-keys
       :collisions (mapv first collisions)})))

(defn fragment-required? [contract input?]
  (cond
    input? (fragment-node-output-required? contract)
    (map? contract) (= true (:required contract))
    :else false))

(defn fragment-parameter-effective-value [contract supplied-map k]
  (if (contains? supplied-map k)
    (get supplied-map k)
    (when (and (map? contract) (contains? contract :default))
      (:default contract))))

(defn fragment-input-effective-bindings [supplied]
  (:map (normalized-fragment-map supplied) {}))

(defn fragment-value-type-ok? [declared value]
  (case declared
    :string (string? value)
    :integer (integer? value)
    :number (number? value)
    :boolean (or (true? value) (false? value))
    false))

(defn fragment-binding-diagnostics [base-path kind contracts supplied input?]
  (let [declared (normalized-fragment-map contracts)
        bound (normalized-fragment-map supplied)
        declared-map (:map declared {})
        bound-map (:map bound {})]
    (concat
      (when (and (some? contracts) (not (map? contracts)))
        [(err :fragment-interface-bindings-not-map (conj base-path kind)
              (str "Fragment interface " (name kind) " declarations must be a map"))])
      (when (and (some? supplied) (not (map? supplied)))
        [(err :fragment-bindings-not-map (conj base-path kind)
              (str "Fragment " (name kind) " bindings must be a map"))])
      (for [k (:invalid-keys declared)]
        (err :fragment-invalid-binding-name (conj base-path kind)
             (str "Fragment " (name kind) " declaration name must be a non-blank string or keyword: " (pr-str k))))
      (for [k (:invalid-keys bound)]
        (err :fragment-invalid-binding-name (conj base-path kind)
             (str "Fragment " (name kind) " binding name must be a non-blank string or keyword: " (pr-str k))))
      (for [k (:collisions declared)]
        (err :fragment-binding-name-collision (conj base-path kind k)
             (str "Fragment " (name kind) " declaration collides after name normalization: " k)))
      (for [k (:collisions bound)]
        (err :fragment-binding-name-collision (conj base-path kind k)
             (str "Fragment " (name kind) " binding collides after name normalization: " k)))
      (for [k (keys bound-map) :when (not (contains? declared-map k))]
        (err (if input? :fragment-unknown-input :fragment-unknown-parameter) (conj base-path kind k)
             (str "Unknown fragment " (name kind) " binding " k)))
      (apply concat
             (for [[k contract] declared-map
                   :let [contract-map? (map? contract)
                         has-effective? (if input?
                                          (contains? bound-map k)
                                          (or (contains? bound-map k)
                                              (and contract-map? (contains? contract :default))))
                         value (if input?
                                 (get bound-map k)
                                 (fragment-parameter-effective-value contract bound-map k))
                         typ (some-> (when contract-map? (:type contract)) normalize-fragment-name-key)]]
               (concat
                 (when-not contract-map?
                   [(err :fragment-binding-contract-not-map (conj base-path kind k)
                         (str "Fragment " (name kind) " declaration must be a map"))])
                 (when (and contract-map?
                            (fragment-required? contract input?)
                            (or (not has-effective?) (nil? value)))
                   [(err (if input? :fragment-input-binding-missing :fragment-parameter-binding-missing)
                         (conj base-path kind k)
                         (str "Fragment requires " (name kind) " " (name k) " but it is not bound"))])
                 (when (and contract-map? (nil? typ))
                   [(err :fragment-missing-scalar-type (conj base-path kind k :type)
                         (str "Fragment " (name kind) " " (name k) " must declare a supported scalar :type"))])
                 (when (and typ (not (contains? fragment-scalar-types typ)))
                   [(err :fragment-unsupported-scalar-type (conj base-path kind k :type)
                         (str "Fragment " (name kind) " " (name k) " declares unsupported type " typ))])
                 (when (and typ (contains? fragment-scalar-types typ) has-effective? (some? value)
                            (not (fragment-value-type-ok? typ value)))
                   [(err (if input? :fragment-input-type-mismatch :fragment-parameter-type-mismatch)
                         (conj base-path kind k)
                         (str "Fragment " (name kind) " " (name k) " must be " (name typ) " without coercion"))])))))))

(defn effective-fragment-parameters [contracts supplied]
  (let [declared (:map (normalized-fragment-map contracts) {})
        bound (:map (normalized-fragment-map supplied) {})]
    (into {}
          (for [[k contract] declared
                :let [has-bound? (contains? bound k)
                      has-default? (and (map? contract) (contains? contract :default))]
                :when (or has-bound? has-default?)]
            [k (if has-bound? (get bound k) (:default contract))]))))

(defn fragment-version-diagnostics [path node pkg]
  (when (contains? node :version)
    (let [wanted (:version node)
          actual (get-in pkg [:metadata :version])]
      (cond
        (or (not (string? wanted)) (str/blank? wanted))
        [(err :fragment-invalid-version (conj path :version)
              "Fragment :version must be a non-blank string when present")]

        (not= wanted actual)
        [(err :fragment-version-mismatch (conj path :version)
              (str "Fragment version " wanted " does not match resolved package version " (pr-str actual)))]))))

(defn fragment-prefix-diagnostics [path node]
  (when (contains? node :prefix)
    (let [prefix (:prefix node)]
      (when-not (spec/safe-relative-prefix? prefix)
        [(err :fragment-invalid-prefix (conj path :prefix)
              (str "Fragment :prefix must be a safe portable relative prefix: " (pr-str prefix)))]))))

(defn exact-boundary-template-ref [value]
  (when (string? value)
    (when-let [[_ root field] (re-matches #"\{\{\s*(inputs|defaults)\.([^}\s]+)\s*\}\}" value)]
      [(keyword root) (keyword field)])))

(defn prefix-resource-path [prefix path]
  (cond
    (nil? path) nil
    (str/blank? (str prefix)) path
    :else (str prefix "/" path)))

(defn prefix-boundary-resource [prefix resource]
  (cond-> resource
    (:path resource) (update :path #(prefix-resource-path prefix %))
    (:schema resource) (update :schema #(prefix-resource-path prefix %))))

(defn workflow-binding-resource-name [wf kind k]
  (let [binding (get-in wf [kind k])]
    (or (some-> (when (map? binding) (or (:name binding) (:resource-name binding))) normalize-resource-value)
        (normalize-resource-value k))))

(defn workflow-binding-resource-path [wf kind k]
  (let [binding (get-in wf [kind k])]
    (when (map? binding)
      (some-> (:path binding) normalize-resource-value))))

(defn workflow-binding-resource-kind [workflow-kind]
  (case workflow-kind
    :inputs :input
    :defaults :default
    workflow-kind))

(defn boundary-input-key-for-resource [input-bindings resource]
  (let [resource-name (normalize-resource-value (:name resource))]
    (some (fn [k]
            (when (= resource-name (normalize-resource-value k)) k))
          (keys input-bindings))))

(defn project-boundary-input-resource [wf input-bindings resource]
  (when-let [input-key (boundary-input-key-for-resource input-bindings resource)]
    (when-let [[workflow-kind ambient-key] (exact-boundary-template-ref (get input-bindings input-key))]
      (let [ambient-path (workflow-binding-resource-path wf workflow-kind ambient-key)]
        (cond-> (assoc (dissoc resource :path)
                       :kind (workflow-binding-resource-kind workflow-kind)
                       :name (workflow-binding-resource-name wf workflow-kind ambient-key))
          ambient-path (assoc :path ambient-path))))))

(defn project-boundary-incoming-resource [wf prefix input-bindings resource]
  (if (boundary-input-key-for-resource input-bindings resource)
    (project-boundary-input-resource wf input-bindings resource)
    (prefix-boundary-resource prefix resource)))

(defn normalized-output-key-map [m]
  (when (map? m)
    (into {} (map (fn [[k v]] [(normalize-fragment-name-key k) v])) m)))

(defn boundary-resource-output-key [resource]
  (normalize-fragment-name-key (:name resource)))

(defn all-exit-output-path [pkg resource]
  (let [exit (get-in pkg [:fragment :exit])
        output-key (boundary-resource-output-key resource)
        paths (for [e exit
                    :let [produces (normalized-output-key-map (:produces e))]
                    :when (contains? produces output-key)]
                (normalize-resource-value (get produces output-key)))]
    (when (and (seq exit)
               (= (count exit) (count paths))
               (= 1 (count (set paths))))
      (first paths))))

(defn project-boundary-produced-resource [prefix pkg resource]
  (when-let [path (all-exit-output-path pkg resource)]
    (-> resource
        (assoc :path (prefix-resource-path prefix path))
        (cond-> (:schema resource) (update :schema #(prefix-resource-path prefix %))))))

(defn fragment-boundary-resources [wf pkg node]
  (let [prefix (when (contains? node :prefix) (:prefix node))
        resources (get-in pkg [:requirements :resources] {})
        input-bindings (fragment-input-effective-bindings (:inputs node {}))]
    {:requires (mapv identity
                     (keep #(project-boundary-incoming-resource wf prefix input-bindings %)
                           (:requires resources [])))
     :consumes (mapv identity
                     (keep #(project-boundary-incoming-resource wf prefix input-bindings %)
                           (:consumes resources [])))
     :produces (mapv identity
                     (keep #(project-boundary-produced-resource prefix pkg %)
                           (:produces resources [])))}))

(defn fragment-effective-contract [wf resolved pkg node]
  (let [iface (:interface pkg)
        prefix (when (contains? node :prefix) (:prefix node))]
    {:package-path (:path resolved)
     :scope (:scope resolved)
     :version (get-in pkg [:metadata :version])
     :prefix prefix
     :inputs (fragment-input-effective-bindings (:inputs node {}))
     :parameters (effective-fragment-parameters (:parameters iface {}) (:parameters node {}))
     :resources (fragment-boundary-resources wf pkg node)}))

(defn fragment-node-result [wf id n opts]
  (let [frag-name (:fragment n)
        path [:states id]
        resolved (resolve-fragment-package wf n)]
    (cond
      (= :invalid-name (:error resolved))
      {:diagnostics [(err :fragment-invalid-name (conj path :fragment)
                          (str "Fragment :fragment must be a single safe package name: " (pr-str frag-name)))]}

      (= :invalid-scope (:error resolved))
      {:diagnostics [(err :fragment-invalid-scope (conj path :scope)
                          "Fragment :scope must be project, global, examples, example, or configured")]}

      (nil? (:path resolved))
      {:diagnostics [(err :fragment-unknown-package (conj path :fragment)
                          (str "Fragment package not found: " frag-name))]}

      :else
      (try
        (let [pkg (spec/read-fragment-package (:path resolved))
              iface (:interface pkg)
              outcomes (set (:outcomes iface))
              covered (set (map keyword (keep fragment-transition-outcome (spec/transitions n))))
              boundary-diagnostics (vec (remove nil?
                                                (apply concat
                                                       [(when (not= frag-name (get-in pkg [:metadata :name]))
                                                          [(err :fragment-name-mismatch (conj path :fragment)
                                                                (str "Fragment package metadata name " (pr-str (get-in pkg [:metadata :name]))
                                                                     " does not match requested fragment " (pr-str frag-name)))])
                                                        (fragment-binding-diagnostics path :inputs (:inputs iface {}) (:inputs n {}) true)
                                                        (fragment-binding-diagnostics path :parameters (:parameters iface {}) (:parameters n {}) false)
                                                        (fragment-version-diagnostics path n pkg)
                                                        (fragment-prefix-diagnostics path n)
                                                        (for [o outcomes :when (not (contains? covered o))]
                                                          (warn :fragment-uncovered-outcome (conj path :transitions)
                                                                (str "Fragment outcome " o " is not covered by any transition")))
                                                        (for [o covered :when (not (contains? outcomes o))]
                                                          (err :fragment-unknown-outcome (conj path :transitions)
                                                               (str "Transition references unknown fragment outcome " o)))])))
              internal-result (when-not (some #(= "error" (:severity %)) boundary-diagnostics)
                                (let [res (lint-fragment-package-cached pkg opts)
                                      fkey (spec/fragment-package-file pkg)
                                      seen (::fragment-internal-seen opts)
                                      failed? (not (:ok res))]
                                  {:failed? failed?
                                   :diagnostics (when (and failed?
                                                           (or (nil? seen)
                                                               (not (contains? @seen fkey))))
                                                  (when seen (swap! seen conj fkey))
                                                  [(err :fragment-internal-lint-failed (conj path :fragment)
                                                        (str "Fragment package " frag-name " failed lint with " (count (:errors res)) " error(s)")
                                                        (str/join "; " (map :message (:errors res))))])}))
              diagnostics (vec (concat boundary-diagnostics (:diagnostics internal-result)))]
          (cond-> {:diagnostics diagnostics}
            (and (not (:failed? internal-result))
                 (not-any? #(= "error" (:severity %)) diagnostics))
            (assoc :inclusion (fragment-effective-contract wf resolved pkg n))))
        (catch Throwable t
          {:diagnostics [(err :fragment-internal-lint-failed (conj path :fragment)
                              (str "Fragment package " frag-name " could not be read: " (.getMessage t)))]})))))

(defn fragment-node-diagnostics [wf id n opts]
  (:diagnostics (fragment-node-result wf id n opts)))

(defn fragment-node-results [wf opts]
  (let [opts (-> opts
                 (assoc ::fragment-internal-cache (atom {}))
                 (assoc ::fragment-internal-seen (atom #{})))]
    (vec
      (keep (fn [[id n]]
              (when (and (map? n) (= :fragment (:type n)))
                [id (fragment-node-result wf id n opts)]))
            (:states wf)))))

(defn fragment-node-checks [wf opts]
  (mapcat (comp :diagnostics second) (fragment-node-results wf opts)))

(defn fragment-inclusion-results [results]
  (into {}
        (keep (fn [[id result]]
                (when-let [incl (:inclusion result)]
                  [id incl])))
        results))

(defn exact-resource-dedupe [resources]
  (vec (distinct resources)))

(defn merge-effective-resource-groups [authored derived]
  (let [authored (or authored {})]
    (reduce (fn [acc group]
              (let [entries (exact-resource-dedupe (concat (get authored group [])
                                                           (get derived group [])))]
                (if (seq entries)
                  (assoc acc group entries)
                  (dissoc acc group))))
            authored
            spec/resource-groups)))

(defn workflow-with-fragment-boundary-resources [wf inclusions]
  (if-not (seq inclusions)
    wf
    (update wf :states
            (fn [states]
              (reduce-kv (fn [acc id inclusion]
                           (if-let [derived (:resources inclusion)]
                             (update-in acc [id :resources]
                                        #(merge-effective-resource-groups % derived))
                             acc))
                         states
                         inclusions)))))

(defn fragment-package-top-level-checks [pkg]
  (let [required [:api-version :kind :metadata :interface :fragment]]
    (concat
      (for [k required :when (not (contains? pkg k))]
        (err :missing-top-level-key [k] (str "Missing required top-level key " k)))
      (when (and (:api-version pkg) (not (contains? spec/supported-fragment-api-versions (:api-version pkg))))
        [(err :unsupported-api-version [:api-version]
              (str "Unsupported api-version " (pr-str (:api-version pkg))))])
      (when (and (:kind pkg) (not= spec/supported-fragment-kind (:kind pkg)))
        [(err :unsupported-kind [:kind] (str "Unsupported kind " (pr-str (:kind pkg))))])
      (when (and (:metadata pkg) (not (map? (:metadata pkg))))
        [(err :metadata-not-map [:metadata] ":metadata must be a map")])
      (when (and (map? (:metadata pkg)) (str/blank? (str (get-in pkg [:metadata :name]))))
        [(err :metadata-missing-name [:metadata :name] "Fragment package metadata must include :name")])
      (when (and (:interface pkg) (not (map? (:interface pkg))))
        [(err :fragment-missing-interface [:interface] ":interface must be a map")])
      (when (and (:fragment pkg) (not (map? (:fragment pkg))))
        [(err :node-not-map [:fragment] ":fragment must be a map")]))))

(defn fragment-interface-checks [pkg]
  (let [iface (:interface pkg)]
    (when (map? iface)
      (let [outputs (:outputs iface {})
            outcomes (:outcomes iface)
            exit (:exit (:fragment pkg) [])
            required-outputs (set (for [[k c] outputs :when (fragment-node-output-required? c)] k))]
        (concat
          (when (or (not (contains? iface :outcomes))
                    (not (set? outcomes))
                    (empty? outcomes)
                    (not (every? keyword? outcomes)))
            [(err :fragment-outcome-mismatch [:interface :outcomes]
                  ":outcomes must be a non-empty set of keywords")])
          (when outcomes
            (let [exit-outcome-counts (frequencies (keep #(some-> (:on %) keyword) exit))
                  exit-outcomes (set (keys exit-outcome-counts))]
              (concat
                (for [[o n] exit-outcome-counts :when (> n 1)]
                  (err :duplicate-exit [:fragment :exit]
                       (str "Outcome has more than one exit entry: " o)))
                (for [o exit-outcomes :when (not (contains? outcomes o))]
                  (err :fragment-outcome-mismatch [:fragment :exit]
                       (str "Exit references unknown outcome: " o)))
                (for [o outcomes :when (not (contains? exit-outcomes o))]
                  (err :fragment-outcome-mismatch [:fragment :exit]
                       (str "Outcome has no exit entry: " o))))))
          (apply concat
                 (for [[idx e] (map-indexed vector exit)]
                   (let [produces (set (keys (:produces e {})))]
                     (for [ro required-outputs :when (not (contains? produces ro))]
                       (err :fragment-exit-missing-output [:fragment :exit idx :produces ro]
                            (str "Required output " ro " is not produced on exit path " (:on e)))))))
          (apply concat
                 (for [[idx e] (map-indexed vector exit)]
                   (for [[k v] (:produces e {}) :when (not (spec/safe-relative-path? v))]
                     (err :fragment-exit-invalid-produces-path [:fragment :exit idx :produces k]
                          (str "Exit :produces path for " k " must be a safe relative path: " (pr-str v)))))))))))
(defn fragment-referenced-assets [fragment]
  (set (remove nil?
               (mapcat
                 (fn [[_ n]]
                   (when (map? n)
                     (concat
                       [(:prompt-template n)
                        (get-in n [:session :continuation-prompt-template])]
                       (when-let [cmd (first (:command n))]
                         (when (path-like-command? cmd) [cmd]))
                       (keep (fn [[_ contract]] (spec/output-schema contract))
                             (spec/output-contracts n)))))
                 (:states fragment {})))))

(defn fragment-asset-checks [pkg]
  (let [declared (declared-asset-paths pkg)
        fragment (:fragment pkg)
        referenced (fragment-referenced-assets fragment)]
    (concat
      (apply concat
             (for [[asset-kind path] (asset-paths pkg)]
               (concat
                 (when-not (spec/safe-relative-path? path)
                   [(err :invalid-asset-path [:assets asset-kind]
                         (str "Asset paths must be safe relative paths: " path))])
                 (when (and (spec/safe-relative-path? path)
                            (not (fs/exists? (spec/resolve-fragment-package-path pkg path))))
                   [(err :fragment-asset-missing [:assets asset-kind]
                         (str "Declared asset does not exist: " path))]))))
      (for [path referenced :when (and path (not (contains? declared path)))]
        (warn :referenced-asset-not-declared [:assets]
              (str "Fragment references an asset that is not declared in :assets: " path))))))

(defn fragment-nested-fragment-checks [pkg]
  (let [fragment (:fragment pkg)
        states (:states fragment {})]
    (when (and (map? fragment) (map? states))
      (for [[id n] states
            :when (and (map? n)
                       (= :fragment (:type n)))]
        (err :nested-fragment [:fragment :states id :type]
             "Nested fragment states are unsupported by the tesseraft.fragment/v1 contract")))))

(defn fragment-terminal-outcome-checks [pkg]
  (let [outcomes (get-in pkg [:interface :outcomes])
        fragment (:fragment pkg)
        states (:states fragment {})]
    (when (and (set? outcomes)
               (seq outcomes)
               (every? keyword? outcomes)
               (map? fragment)
               (map? states))
      (let [wf-like {:initial (:initial fragment) :states states}
            reachable (spec/reachable-states wf-like)
            reachable-terminals (for [[id n] states
                                      :when (and (contains? reachable id)
                                                 (map? n)
                                                 (= :terminal (:type n)))]
                                  [id n])
            produced-outcomes (set (for [[_ n] reachable-terminals
                                    :let [outcome (:outcome n)]
                                    :when (contains? outcomes outcome)]
                                outcome))]
        (concat
          (apply concat
                 (for [[id n] reachable-terminals]
                   (let [outcome (:outcome n)]
                     (cond
                       (nil? outcome)
                       [(err :fragment-terminal-missing-outcome [:fragment :states id :outcome]
                             (str "Terminal state " id " must select a declared fragment outcome"))]

                       (and (set? outcome) (> (count outcome) 1))
                       [(err :fragment-terminal-ambiguous-outcome [:fragment :states id :outcome]
                             (str "Terminal state " id " ambiguously selects multiple fragment outcomes " outcome))]

                       (not (contains? outcomes outcome))
                       [(err :fragment-terminal-unknown-outcome [:fragment :states id :outcome]
                             (str "Terminal state " id " selects unknown fragment outcome " outcome))]

                       :else []))))
          (for [o outcomes :when (not (contains? produced-outcomes o))]
            (err :fragment-unreachable-outcome [:interface :outcomes]
                 (str "Declared fragment outcome " o " is not produced by any reachable terminal state"))))))))

(defn fragment-internal-inputs [pkg]
  ;; The fragment's internal subgraph references boundary inputs/parameters
  ;; via template vars (e.g. {{inputs.repo-root}}). The boundary contract
  ;; lives in :interface, not on the internal "workflow-like" object, so to
  ;; run the workflow template-var/node-contract primitives meaningfully we
  ;; synthesize an :inputs map from the interface inputs AND parameters
  ;; (parameters become template vars inside the fragment too). This keeps
  ;; the valid fixture green while still catching genuinely unknown roots.
  (let [iface (:interface pkg {})
        inputs (:inputs iface {})
        params (:parameters iface {})]
    (merge inputs params)))

(defn fragment-internal-subgraph-checks [pkg opts]
  (let [fragment (:fragment pkg)
        states (:states fragment {})]
    (when (and (map? fragment) (map? states))
      ;; Build a workflow-like object so the reusable workflow linter
      ;; primitives prove the internal subgraph once, here. We carry
      ;; :__dir/:__file from the package (so prompt/schema/path resolution
      ;; resolves relative to the fragment dir, like read-workflow) and a
      ;; synthesized :inputs from the boundary interface (so template-var
      ;; checks for boundary inputs/parameters resolve). This is the
      ;; mandatory single internal proof; inclusion sites do not re-prove.
      (let [wf-like {:initial (:initial fragment)
                     :defaults (:defaults fragment)
                     :policies (:policies fragment)
                     :inputs (fragment-internal-inputs pkg)
                     :__dir (spec/fragment-package-dir pkg)
                     :__file (spec/fragment-package-file pkg)
                     :states states}]
        (concat
          (let [required [:initial :states]]
            (for [k required :when (not (contains? fragment k))]
              (err :missing-top-level-key [:fragment k] (str "Missing required fragment key " k))))
          (when (and (:initial fragment)
                     (map? states)
                     (not (contains? states (:initial fragment))))
            [(err :missing-initial-state [:fragment :initial]
                  (str "Initial state does not exist: " (:initial fragment)))])
          (when (and (map? states) (empty? (spec/terminal-ids wf-like)))
            [(err :missing-terminal-state [:fragment :states]
                  "Fragment must declare at least one :terminal node")])
          (node-type-checks wf-like)
          (transition-checks wf-like)
          (reachability-checks wf-like)
          (node-contract-checks wf-like opts)
          (duplicate-output-checks wf-like)
          (workflow-resource-checks wf-like)
          (cycle-checks wf-like)
          (template-var-checks wf-like)
          (apply concat
                 (for [[id n] states :when (map? n)]
                   (path-contract-checks wf-like id n))))))))

;; Per-lint-workflow-invocation cache of fragment internal lint results,
;; keyed by resolved file path, so a workflow importing the same fragment at
;; multiple sites surfaces the internal-proof signal at most once per file
;; path without re-running the internal subgraph lint on every import site.
(defn fragment-internal-cache [opts]
  (or (::fragment-internal-cache opts)
      (atom {})))

(defn lint-fragment-package-cached [pkg opts]
  (let [cache (fragment-internal-cache opts)
        key (spec/fragment-package-file pkg)]
    (if (and key (map? @cache))
      (or (get @cache key)
          (let [res (lint-fragment-package pkg opts)]
            (swap! cache assoc key res)
            res))
      (lint-fragment-package pkg opts))))

(defn fragment-resource-checks [pkg]
  (concat
    (resource-declaration-checks [:requirements :resources] (get-in pkg [:requirements :resources]))
    (resource-declaration-checks [:fragment :resources] (get-in pkg [:fragment :resources]))))

(defn lint-fragment-package
  ([pkg] (lint-fragment-package pkg {}))
  ([pkg opts]
   (let [diagnostics (vec (remove nil?
                                   (apply concat
                                     [(fragment-package-top-level-checks pkg)
                                      (fragment-interface-checks pkg)
                                      (fragment-nested-fragment-checks pkg)
                                      (fragment-terminal-outcome-checks pkg)
                                      (fragment-internal-subgraph-checks pkg opts)
                                      (fragment-resource-checks pkg)
                                      (fragment-asset-checks pkg)])))
         strict? (:strict opts)
         errors (filter #(or (= "error" (:severity %))
                             (and strict? (= "warning" (:severity %)))) diagnostics)
         warnings (filter #(= "warning" (:severity %)) diagnostics)]
     {:ok (empty? errors)
      :fragment-package (spec/fragment-package-file pkg)
      :errors (vec errors)
      :warnings (vec warnings)
      :diagnostics diagnostics})))

(defn lint-fragment-package-file
  ([fragment-file] (lint-fragment-package-file fragment-file {}))
  ([fragment-file opts]
   (try
     (let [pkg (spec/read-fragment-package fragment-file)]
       (lint-fragment-package pkg opts))
     (catch Throwable t
       {:ok false
        :fragment-package (str fragment-file)
        :errors [(err :parse-error [] (.getMessage t))]
        :warnings []
        :diagnostics [(err :parse-error [] (.getMessage t))]}))))
