(ns tesseraft.runtime.approvals
  (:require [babashka.fs :as fs]
            [tesseraft.runtime.approval-server :as approval-server]
            [tesseraft.runtime.store :as store]
            [tesseraft.runtime.transitions :as transitions]
            [tesseraft.spec :as spec]))

(def advance transitions/advance)
(def finish-if-terminal transitions/finish-if-terminal)

(defn approval-request-path [ctx state-id attempt]
  (fs/path (get-in ctx [:run :dir]) "approvals" (str (name state-id) "-" attempt ".json")))

(defn approval-decision-path [ctx state-id attempt]
  (fs/path (get-in ctx [:run :dir]) "approvals" (str (name state-id) "-" attempt "-decision.json")))

(defn approval-finalization-path [ctx approval-id]
  (fs/path (get-in ctx [:run :dir]) "approval-finalizations" (str approval-id ".json")))

(defn load-approval-finalization [ctx approval-id]
  (let [path (approval-finalization-path ctx approval-id)]
    (when (fs/exists? path) (store/read-json path))))

(defn write-approval-finalization! [ctx approval-id record]
  (store/write-runtime-json! ctx (approval-finalization-path ctx approval-id) record)
  record)

(defn load-approval-decision [ctx state-id attempt]
  (let [p (approval-decision-path ctx state-id attempt)]
    (when (fs/exists? p) (store/read-json p))))

(defn render-artifact [ctx node]
  (when-let [art (:artifact node)]
    (cond
      (string? art) {:path (spec/render-template-string art ctx)}
      (map? art) (cond-> art
                   (string? (:path art))
                   (assoc :path (spec/render-template-string (:path art) ctx)))
      :else art)))

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
        (update :decisions
                (fn [decisions]
                  (mapv (fn [decision]
                          ;; `consequences` shipped in early examples. Keep it
                          ;; readable while materializing the canonical
                          ;; singular wire field.
                          (cond-> decision
                            (and (nil? (:consequence decision))
                                 (:consequences decision))
                            (assoc :consequence (:consequences decision))))
                        decisions)))
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
    (let [approval-id (:approval_id decision)
          finalization (load-approval-finalization ctx approval-id)
          finalization-id (or (:finalization_id decision) (:finalization_id finalization))
          result (cond-> {:status "ok" :ok true
                          :approval_id approval-id
                          :decision (:decision decision)
                          :message (or (:message decision) (:summary decision))
                          :annotations (:annotations decision [])}
                   (:feedback_path decision) (assoc :issues_file (:feedback_path decision))
                   finalization-id (assoc :finalization_id finalization-id))
          ; spec/match-transition? compares :when predicates against result keys.
          tr (or (some #(when (spec/match-transition? result %) %) (spec/transitions node))
                 (throw (ex-info "No approval transition matched the recorded decision"
                                 {:state state-id :decision (:decision decision)})))
          _ (when (and finalization
                       (or (not= (:target_state finalization) (name (:next tr)))
                           (not= (:effects finalization) (mapv name (:effects tr [])))))
              (throw (ex-info "Pinned approval finalization no longer matches workflow"
                              {:code :approval_finalization_workflow_mismatch
                               :approval-id approval-id})))
          ctx ((if finalization-id store/event-once! store/event!)
               ctx (cond-> {:event "approval.decided"
                            :state (name state-id)
                            :attempt attempt
                            :approval_id approval-id
                            :decision (:decision decision)
                            :message_present (boolean (seq (:message result)))
                            :annotation_count (count (:annotations result))}
                     finalization-id (assoc :event_id (str finalization-id "/approval-decided"))))
          ctx ((if finalization-id store/event-once! store/event!)
               ctx (cond-> {:event "transition.selected"
                            :from (name state-id)
                            :to (name (:next tr))
                            :effects (mapv name (:effects tr []))}
                     finalization-id (assoc :event_id (str finalization-id "/transition"))))
          ;; A decision releases the block. A terminal destination will replace
          ;; running with done; a nonterminal destination stays running/parked
          ;; and can optionally be resumed by the caller.
          active (assoc-in ctx [:run :status] "running")
          advanced (-> (advance active tr result)
                       (assoc :last-approval
                              {:approval-id approval-id
                               :decision (:decision decision)
                               :message (:message result)
                               :annotations (:annotations result)
                               :decision-path (str "approvals/" approval-id "-decision.json")})
                       (cond-> finalization-id
                         (assoc-in [:approval-finalizations approval-id]
                                   {:finalization-id finalization-id :decision-committed true}))
                       (#(finish-if-terminal wf % finalization-id)))
          saved (store/save-context! advanced)]
      (when finalization
        (write-approval-finalization! saved approval-id
          (assoc finalization :decision_status "committed" :committed_at (store/now))))
      saved)
    ;; Pause: no decision yet. Write the approval-request record (idempotent),
    ;; append approval.requested only on first creation, mark the run blocked,
    ;; and park. Returning a blocked ctx makes run-until-done! stop cleanly.
    (let [req-path (approval-request-path ctx state-id attempt)
          already? (fs/exists? req-path)
          approval-id (str (name state-id) "-" attempt)
          existing (when already? (store/read-json req-path))
          review-config (:review-server node)
          evidence (when (and review-config (not already?))
                     (approval-server/snapshot-diff! ctx approval-id (:max-diff-bytes review-config)))
          review-record (when evidence
                          {:kind "git-diff" :evidence_path (:path evidence)
                           :evidence_sha256 (:sha256 evidence) :evidence_size (:size evidence)
                           :max_diff_bytes (:max_bytes evidence)
                           :head_tree (:head_tree evidence)
                           :index_fingerprint (:index_fingerprint evidence)
                           :context_fingerprint (:context_fingerprint evidence)
                           :watch_provider (:watch_provider evidence)
                           :watch_count (:watch_count evidence)
                           :watch_overflow (:watch_overflow evidence)
                           :anchors (approval-server/diff-anchors
                                     (slurp (str (fs/path (get-in ctx [:run :dir]) (:path evidence)))))} )
          artifact (if evidence {:path (:path evidence) :kind "diff" :label "Current Git changes"}
                       (render-artifact ctx node))
          presentation (cond-> (approval-presentation ctx node)
                         evidence (assoc :artifacts [artifact]))
          request (or existing
                      (cond-> {:version 1
                               :approval_id approval-id
                               :run_id (get-in ctx [:run :id])
                               :state (name state-id)
                               :attempt attempt
                               :message (:message node)
                               :artifact artifact
                               :question (:question presentation)
                               :artifacts (:artifacts presentation)
                               :decisions (:decisions presentation)
                               :routing (:routing presentation)
                               :requested_at (store/now)
                               :status "pending"}
                        review-record (assoc :review_server review-record)))
          ctx (if already?
                ctx
                (do
                  (store/write-runtime-json! ctx req-path request)
                  (when review-config (approval-server/launch! ctx state-id attempt request))
                  (store/event! ctx {:event "approval.requested"
                                     :state (name state-id)
                                     :attempt attempt
                                     :approval_id approval-id
                                     :artifact (and artifact (:path artifact))})))
          ctx (-> ctx
                  (assoc-in [:run :status] "blocked")
                  (assoc-in [:run :updated-at] (store/now)))]
      (store/save-context! ctx))))
