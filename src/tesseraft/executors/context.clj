(ns tesseraft.executors.context
  (:require
    [babashka.fs :as fs]
    [clojure.string :as str]
    [tesseraft.runtime.store :as store]
    [tesseraft.spec :as spec]))

(defn execution-context [ctx state-id node]
  (merge ctx {:node {:id state-id :config node}
              :agent {:status-path (spec/status-output-path node)}}))

(defn render-prompt! [wf ctx state-id node]
  (let [template-path (spec/resolve-workflow-path wf (:prompt-template node))
        template (slurp template-path)
        context (execution-context ctx state-id node)
        rendered (spec/render-template-string template context)
        output (or (:prompt-output node)
                   (str "prompts/generated/" (name state-id) "-" (get-in ctx [:run :attempt]) ".md"))
        output-path (str (fs/path (get-in ctx [:run :dir])
                                  (spec/render-template-string output context)))]
    (store/write-runtime-text! ctx output-path rendered)
    output-path))

(defn session-name [wf ctx state-id node]
  (let [fallback (str (or (get-in ctx [:inputs :item-id])
                          (get-in ctx [:run :work-item :identifier])
                          (get-in wf [:metadata :name])
                          (get-in ctx [:run :id])
                          "workflow")
                      "-" (name state-id) "-" (get-in ctx [:run :attempt]))]
    (spec/render-template-string (or (:session-name node) fallback)
                                 (execution-context ctx state-id node))))

(defn runtime-cwd [ctx state-id node]
  (let [context (execution-context ctx state-id node)]
    (or (some-> (get-in node [:runtime :cwd]) (spec/render-template-string context) not-empty)
        (get-in ctx [:run :worktree-dir])
        (get-in ctx [:inputs :repo-root])
        (get-in ctx [:inputs :repo])
        ".")))

(defn git-env [ctx]
  (when-let [identity (get-in ctx [:run :git-user])]
    {"GIT_AUTHOR_NAME" (:name identity)
     "GIT_AUTHOR_EMAIL" (:email identity)
     "GIT_COMMITTER_NAME" (:name identity)
     "GIT_COMMITTER_EMAIL" (:email identity)
     "GIT_USER_NAME" (:name identity)
     "GIT_USER_EMAIL" (:email identity)}))

(defn agent-env [ctx state-id]
  (merge {"AGENT_RUN_DIR" (get-in ctx [:run :dir])
          "AGENT_STATE" (name state-id)
          "AGENT_ATTEMPT" (str (get-in ctx [:run :attempt]))}
         (git-env ctx)))
