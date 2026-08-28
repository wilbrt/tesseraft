(ns tesseraft.contract.normalize
  (:require [tesseraft.contract.parse :as parse]))

(def semantic-keyword parse/semantic-keyword)
(defn- semantic-keywords [xs]
  (cond (set? xs) (set (map semantic-keyword xs)) (vector? xs) (mapv semantic-keyword xs) (sequential? xs) (map semantic-keyword xs) :else xs))
(defn- normalize-interface [x]
  (if-not (map? x) x (cond-> x (contains? x :outcomes) (update :outcomes #(if (sequential? %) (set (map semantic-keyword %)) %)))))
(defn- normalize-states [states]
  (if-not (map? states) states
    (let [entries (map (fn [[id node]] [(parse/keywordize-node-id id) (parse/normalize-node node)]) states) ids (map first entries)]
      (if (= (count ids) (count (set ids))) (into {} entries)
        (assoc (into {} (map (fn [[id node]] [id (parse/normalize-node node)])) states) ::state-id-collision nil)))))
(defn- normalize-body [x]
  (if-not (map? x) x
    (cond-> x
      (contains? x :initial) (update :initial parse/keywordize-node-id)
      (contains? x :entry) (update :entry #(if-not (map? %) % (cond-> % (contains? % :inputs) (update :inputs semantic-keywords) (contains? % :parameters) (update :parameters semantic-keywords))))
      (contains? x :exit) (update :exit #(if (sequential? %) (mapv (fn [e] (if (and (map? e) (contains? e :on)) (update e :on semantic-keyword) e)) %) %))
      (contains? x :states) (update :states normalize-states))))
(defn- normalize-requirements [x]
  (parse/normalize-requirements x))
(defn- normalize-policies [x]
  (parse/normalize-policies x))
(defn normalize-fragment-package [pkg]
  (if-not (map? pkg) pkg
    (cond-> pkg
      (contains? pkg :kind) (update :kind semantic-keyword)
      (contains? pkg :interface) (update :interface normalize-interface)
      (contains? pkg :requirements) (update :requirements normalize-requirements)
      (contains? pkg :fragment) (update :fragment #(cond-> (normalize-body %) (and (map? %) (contains? % :policies)) (update :policies normalize-policies))))))
(defn read-fragment-package [file] (normalize-fragment-package (parse/read-data-file file)))
(defn- portable-key [k] (cond (keyword? k) (if-let [ns (namespace k)] (str ns "/" (name k)) (name k)) (string? k) k :else (str k)))
(defn- portable-value [x]
  (cond
    (keyword? x) (portable-key x)
    (set? x) (->> x (map portable-value) (sort-by pr-str) vec)
    (map? x) (let [entries (map (fn [[k v]] [(portable-key k) k (portable-value v)]) x)
                   duplicate (->> entries (group-by first) (keep (fn [[projected values]] (when (< 1 (count values)) {:projected-key projected :source-keys (mapv second values)}))) first)]
               (when duplicate (throw (ex-info "Portable fragment projection has duplicate map key" duplicate)))
               (into (sorted-map) (map (fn [[projected _ v]] [projected v])) entries))
    (vector? x) (mapv portable-value x)
    (sequential? x) (mapv portable-value x)
    :else x))
(defn portable-fragment-package-data [pkg] (portable-value (dissoc pkg :__file :__dir)))
