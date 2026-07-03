(ns tesseraft.executors.pi-cli
  (:require
    [tesseraft.spec :as spec]
    [tesseraft.runtime.store :as store]
    [babashka.fs :as fs]
    [babashka.process :as p]
    [clojure.string :as str]))

(defn env [k default] (or (System/getenv k) default))
(defn comma-tools [tools] (when (seq tools) (->> tools (map name) (str/join ","))))

;; Conservative map of pinned :provider -> the environment variable that pi
;; expects to hold its API key. Only providers listed here get a pre-flight
;; credential check; unknown providers warn and continue so the guard never
;; blocks a legitimately-credentialed custom provider we do not map.
(def ^:private provider-api-key-env
  {"opencode-go" "OPENCODE_API_KEY"})

(defn- credential-error [provider env-var]
  (str "Pinned :provider \"" provider "\" has no " env-var
       " in this environment. Set " env-var
       " or remove the :provider/:model pin so the node falls back to pi's default provider."))

(defn- check-pinned-provider-credentials!
  "Pre-flight check that a pinned :provider is credentialed. Returns nil when OK
  to proceed, or a credential-error string when a known-mapped provider is
  missing its API key. Unknown providers are treated as credentialed (warn only)."
  [provider]
  (when provider
    (if-let [env-var (get provider-api-key-env provider)]
      (when (str/blank? (System/getenv env-var))
        (credential-error provider env-var))
      ;; Unknown provider: do not block. A warning is emitted by the caller.
      nil)))

(defn execution-context [ctx state-id node]
  (merge ctx {:node {:id state-id :config node}
              :agent {:status-path (spec/status-output-path node)}}))

(defn render-prompt! [wf ctx state-id node]
  (let [template-path (spec/resolve-workflow-path wf (:prompt-template node))
        template (slurp template-path)
        ectx (execution-context ctx state-id node)
        rendered (spec/render-template-string template ectx)
        prompt-output (or (:prompt-output node)
                          (str "prompts/generated/" (name state-id) "-" (get-in ctx [:run :attempt]) ".md"))
        rendered-output (spec/render-template-string prompt-output ectx)
        output-path (str (fs/path (get-in ctx [:run :dir]) rendered-output))]
    (fs/create-dirs (fs/parent output-path))
    (spit output-path rendered)
    output-path))

(defn session-name [ctx state-id node]
  (let [template (or (:session-name node) (str "{{inputs.ticket}}-" (name state-id) "-{{run.attempt}}"))]
    (spec/render-template-string template (execution-context ctx state-id node))))

(defn runtime-cwd [ctx state-id node]
  (let [ectx (execution-context ctx state-id node)]
    (or (some-> (get-in node [:runtime :cwd]) (spec/render-template-string ectx) not-empty)
        (get-in ctx [:run :worktree-dir])
        (get-in ctx [:inputs :repo-root])
        (get-in ctx [:inputs :repo])
        ".")))

(defn run-agent-node! [wf ctx state-id node]
  (let [pi-bin (env "PI_BIN" "pi")
        run-dir (get-in ctx [:run :dir])
        repo-root (runtime-cwd ctx state-id node)
        prompt-file (render-prompt! wf ctx state-id node)
        session-dir (str (fs/path run-dir "pi-sessions"))
        session-name (session-name ctx state-id node)
        tools (comma-tools (:tools node))
        provider (:provider node)
        model (:model node)
        cred-error (check-pinned-provider-credentials! provider)
        log-file (str (fs/path run-dir "logs" (str (name state-id) "-" (get-in ctx [:run :attempt]) ".log")))
        args (cond-> [pi-bin "--approve" "--session-dir" session-dir "--name" session-name]
               tools (into ["--tools" tools])
               provider (into ["--provider" provider])
               model (into ["--model" model])
               true (into ["-p" (str "@" prompt-file)]))]
    (fs/create-dirs (fs/parent log-file))
    (when (and provider (not (contains? provider-api-key-env provider)))
      (spit log-file
            (str "WARNING: pinned :provider \"" provider "\" is not in the known provider->env map; "
                 "skipping credential pre-check.\n\n")))
    (if cred-error
      (do
        (spit log-file
              (str "PROVIDER: " (or provider "<default>") "\n"
                   "MODEL: " (or model "<default>") "\n\n"
                   "STATUS: credential-error\n\n"
                   cred-error "\n"))
        (cond-> {:executor "pi-cli"
                 :ok false
                 :exit-code 1
                 :prompt-file prompt-file
                 :log-file log-file
                 :session-name session-name
                 :error cred-error}
          provider (assoc :provider provider)
          model (assoc :model model)))
      (do
        (spit log-file
              (str "COMMAND: " (str/join " " args) "\n\n"
                   "CWD: " repo-root "\n\n"
                   "PROVIDER: " (or provider "<default>") "\n"
                   "MODEL: " (or model "<default>") "\n\n"
                   "PROMPT_FILE: " prompt-file "\n\n"
                   "STATUS: running\n\n"))
        (let [result (apply p/shell {:dir repo-root
                                     :out :string :err :string :continue true
                                     :extra-env {"AGENT_RUN_DIR" run-dir
                                                 "AGENT_STATE" (name state-id)
                                                 "AGENT_ATTEMPT" (str (get-in ctx [:run :attempt]))}}
                            args)]
          (spit log-file
                (str "STATUS: exited " (:exit result) "\n\n"
                     "STDOUT:\n" (:out result) "\n\nSTDERR:\n" (:err result) "\n")
                :append true)
          (cond-> {:executor "pi-cli"
                   :ok (zero? (:exit result))
                   :exit-code (:exit result)
                   :prompt-file prompt-file
                   :log-file log-file
                   :session-name session-name}
            provider (assoc :provider provider)
            model (assoc :model model)))))))
