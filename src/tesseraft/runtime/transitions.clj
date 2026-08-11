(ns tesseraft.runtime.transitions
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [tesseraft.runtime.store :as store]
            [tesseraft.spec :as spec]))

(defn choose-transition [node result]
  (or (some #(when (spec/match-transition? result %) %) (spec/transitions node))
      (throw (ex-info "No transition matched result" {:result result}))))

(defn normalize-issue-path [ctx p]
  (when (and p (not (str/blank? (str p))))
    (if (str/starts-with? (str p) "/") p (str (fs/path (get-in ctx [:run :dir]) p)))))

(defn merge-issues! [ctx result]
  (if-let [issue-file (normalize-issue-path ctx (:issues_file result))]
    (if (fs/exists? issue-file)
      (let [old (if (fs/exists? (get-in ctx [:run :issues-file])) (store/read-json (get-in ctx [:run :issues-file])) [])
            new (store/read-json issue-file)
            keyfn (fn [i] [(:source i) (:title i) (:details i)])
            merged (->> (concat old new) (map #(vector (keyfn %) %)) (into {}) vals vec)]
        (store/write-runtime-json! ctx (get-in ctx [:run :issues-file]) merged)
        ctx)
      ctx)
    ctx))

(defn apply-effect [ctx effect result]
  (store/event! ctx {:event "effect.applied" :effect (name effect)})
  (case effect
    :merge-issues (merge-issues! ctx result)
    :clear-issues (do (store/write-runtime-json! ctx (get-in ctx [:run :issues-file]) []) ctx)
    :inc-round (update-in ctx [:run :round] inc)
    :inc-feedback-cycle (update-in ctx [:run :feedback-cycle] inc)
    :fail-run (assoc-in ctx [:run :status] "failed")
    :set-context ctx
    :record-pr ctx
    (throw (ex-info "Unknown effect" {:effect effect}))))

(defn apply-effects [ctx effects result]
  (reduce #(apply-effect %1 %2 result) ctx effects))

(defn carry-result-context [ctx result]
  (cond-> ctx
    (:worktree-dir result) (assoc-in [:run :worktree-dir] (:worktree-dir result))
    (:branch result) (assoc-in [:run :branch] (:branch result))))

(defn advance [ctx transition result]
  (-> ctx
      (carry-result-context result)
      (apply-effects (:effects transition []) result)
      (assoc-in [:run :state] (:next transition))
      (update-in [:run :attempt] inc)
      (assoc-in [:run :updated-at] (store/now))))

(defn finish-if-terminal [wf ctx]
  (let [state-id (get-in ctx [:run :state])
        node (spec/node wf state-id)]
    (if (= :terminal (:type node))
      (do
        (store/event! ctx {:event "run.finished" :state (name state-id)})
        (-> ctx
            (assoc-in [:run :status] "done")
            (assoc-in [:run :updated-at] (store/now))))
      ctx)))

(defn max-rounds-exceeded? [wf ctx]
  (let [maximum (get-in wf [:defaults :max-rounds])
        current (get-in ctx [:run :round] 1)]
    (and (integer? maximum) (pos? maximum) (> current maximum))))

(defn fail-max-rounds! [wf ctx]
  (let [maximum (get-in wf [:defaults :max-rounds])
        current (get-in ctx [:run :round])
        failed (-> ctx
                   (assoc-in [:run :status] "failed")
                   (assoc-in [:run :updated-at] (store/now)))]
    (store/event! failed {:event "run.max-rounds-exceeded"
                          :status "failed"
                          :round current
                          :max_rounds maximum
                          :state (some-> (get-in ctx [:run :state]) name)})
    (store/save-context! failed)
    failed))
