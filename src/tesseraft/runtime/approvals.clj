(ns tesseraft.runtime.approvals
  (:require [babashka.fs :as fs]
            [tesseraft.runtime.store :as store]
            [tesseraft.runtime.transitions :as transitions]
            [tesseraft.spec :as spec]))

(def advance transitions/advance)
(def finish-if-terminal transitions/finish-if-terminal)

(defn approval-request-path [ctx state-id attempt]
  (fs/path (get-in ctx [:run :dir]) "approvals" (str (name state-id) "-" attempt ".json")))

(defn approval-decision-path [ctx state-id attempt]
  (fs/path (get-in ctx [:run :dir]) "approvals" (str (name state-id) "-" attempt "-decision.json")))

(defn load-approval-decision [ctx state-id attempt]
  (let [p (approval-decision-path ctx state-id attempt)]
    (when (fs/exists? p) (store/read-json p))))

(defn render-artifact [ctx node]
  (when-let [art (:artifact node)]
    (cond-> art
      (string? (:path art))
      (assoc :path (spec/render-template-string (:path art) ctx)))))

;; ---- approval presentation contract ----
;; The Web UI should render the decision screen from the durable request
;; record rather than hard-coded labels, so phase-2 reviewer routing becomes
;; a routing change instead of a redesign. When the node author supplies an
;; explicit `:presentation` block, it is materialized verbatim (with
;; template-rendered artifact paths). When absent, we synthesize a minimal
;; presentation from the legacy `:message` + single `:artifact` form and the
;; node's `:transitions` whose `:when` carries a `:decision`. `routing`
;; defaults to `{:kind :self}`. The posted `decision` string still matches
;; transition `:when {:decision "..."}` unchanged.
(defn approval-presentation [ctx node]
  (if-let [pres (:presentation node)]
    (-> pres
        (update :question #(some-> % str))
        (update :artifacts
                (fn [arts]
                  (mapv (fn [a]
                          (cond-> a
                            (and (map? a) (string? (:path a)))
                            (assoc :path (spec/render-template-string (:path a) ctx))))
                        arts)))
        (update :routing #(or % {:kind :self})))
    ;; Synthesize from the legacy form.
    (let [artifact (render-artifact ctx node)
          decisions (->> (spec/transitions node)
                         (keep (fn [tr]
                                 (when-let [d (get-in tr [:when :decision])]
                                   {:decision (str d)
                                    :label (str d)
                                    :next (some-> (:next tr) name)}))))]
      {:question (some-> (:message node) str)
       :artifacts (if artifact [artifact] [])
       :decisions decisions
       :routing {:kind :self}})))

(defn step-approval! [wf ctx state-id attempt node]
  (if-let [decision (load-approval-decision ctx state-id attempt)]
    ;; Resume: a decision record exists. Build a result carrying :decision so
    ;; the node's :transitions :when {:decision "..."} can match, then advance.
    (let [result {:status "ok" :ok true
                  :approval_id (:approval_id decision)
                  :decision (:decision decision)}
          ; spec/match-transition? compares :when predicates against result keys.
          tr (or (some #(when (spec/match-transition? result %) %) (spec/transitions node))
                 (throw (ex-info "No approval transition matched the recorded decision"
                                 {:state state-id :decision (:decision decision)})))
          ctx (store/event! ctx {:event "approval.decided"
                                  :state (name state-id)
                                  :attempt attempt
                                  :approval_id (:approval_id decision)
                                  :decision (:decision decision)})
          ctx (store/event! ctx {:event "transition.selected"
                                  :from (name state-id)
                                  :to (name (:next tr))
                                  :effects (mapv name (:effects tr []))})
          advanced (finish-if-terminal wf (advance ctx tr result))]
      (store/save-context! advanced))
    ;; Pause: no decision yet. Write the approval-request record (idempotent),
    ;; append approval.requested only on first creation, mark the run blocked,
    ;; and park. Returning a blocked ctx makes run-until-done! stop cleanly.
    (let [req-path (approval-request-path ctx state-id attempt)
          already? (fs/exists? req-path)
          artifact (render-artifact ctx node)
          presentation (approval-presentation ctx node)
          approval-id (str (name state-id) "-" attempt)
          request {:version 1
                   :approval_id approval-id
                   :run_id (get-in ctx [:run :id])
                   :state (name state-id)
                   :attempt attempt
                   :message (:message node)
                   :artifact artifact
                   ;; Presentation contract (P0.2 review). The UI renders the
                   ;; decision screen from these fields; legacy `message` /
                   ;; `artifact` are kept for backward compatibility. When the
                   ;; node authored a `:presentation`, it is materialized
                   ;; verbatim; otherwise a minimal one is synthesized from
                   ;; `:message` + `:artifact` + decision transitions.
                   :question (:question presentation)
                   :artifacts (:artifacts presentation)
                   :decisions (:decisions presentation)
                   :routing (:routing presentation)
                   :requested_at (store/now)
                   :status "pending"}
          ctx (if already?
                ctx
                (do (store/write-runtime-json! ctx req-path request)
                    (store/event! ctx {:event "approval.requested"
                                       :state (name state-id)
                                       :attempt attempt
                                       :approval_id approval-id
                                       :artifact (and artifact (:path artifact))})))
          ctx (-> ctx
                  (assoc-in [:run :status] "blocked")
                  (assoc-in [:run :updated-at] (store/now)))]
      (store/save-context! ctx))))
