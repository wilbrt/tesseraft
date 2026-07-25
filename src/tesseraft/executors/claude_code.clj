(ns tesseraft.executors.claude-code
  "Agent executor for the Claude Code CLI.

  Rationale: this is the *subscription* path. The `claude` binary authenticates
  via its own Claude Pro/Max OAuth login, so a user with a coding subscription can
  run tesseraft workflows without an Anthropic API key. To protect that auth
  mode, this executor actively *removes* `ANTHROPIC_API_KEY` from the subprocess
  environment (Claude Code would otherwise use it for API-key billing instead of
  the subscription). Login state is left to the CLI to surface; we do not invent
  an API-key credential gate.

  The invocation uses Claude Code's non-interactive *agentic* mode:
  `claude --print --dangerously-skip-permissions` with the rendered prompt fed
  via stdin, `--model` for node-pinned model selection, and `--allowedTools`
  mapped from the tesseraft node `:tools` keywords. Plain `--print` is read-only
  inspect mode; the `--dangerously-skip-permissions` flag (the `claude-code`
  analogue of pi's `--approve`) is what lets the agent actually perform file
  edits / run tools so it can write the status artifacts the workflow contract
  requires. A per-node session name is persisted under the run directory for
  future resume support; exact resume flags vary across `claude` versions and
  are best-effort until the installed CLI's session-id output schema is
  confirmed."
  (:require
    [tesseraft.executors.pi-cli :as pi-cli]
    [tesseraft.spec :as spec]
    [tesseraft.runtime.store :as store]
    [babashka.fs :as fs]
    [babashka.process :as p]
    [clojure.string :as str]))

(defn env [k default] (or (System/getenv k) default))

;; Map tesseraft node `:tools` keywords to Claude Code tool names. Plain
;; `--print` is inspect-only; these tools plus `--dangerously-skip-permissions`
;; (below) are what make the executor agentic so it can write required artifacts.
(def ^:private tool-name
  {:read  "Read"
   :bash  "Bash"
   :edit  "Edit"
   :write "Write"
   :grep  "Grep"
   :find  "Glob"
   :ls    "LS"})

(defn- comma-tools [tools]
  (when (seq tools)
    (->> tools (keep tool-name) (str/join ","))))

(defn- log-file [ctx state-id]
  (str (fs/path (get-in ctx [:run :dir]) "logs"
                (str (name state-id) "-claude-code-" (get-in ctx [:run :attempt]) ".log"))))

(defn- session-dir [ctx]
  (str (fs/path (get-in ctx [:run :dir]) "claude-sessions")))

(defn- subenv-without-api-key
  "Returns an `:extra-env` map that strips `ANTHROPIC_API_KEY` so the `claude`
  subprocess is forced onto subscription auth, even if the key is set in the
  parent environment. A nil value removes the variable (verified empirically
  against babashka.process)."
  [extra]
  (merge (or extra {}) {"ANTHROPIC_API_KEY" nil}))

(defn run-agent-node! [wf ctx state-id node]
  (let [claude-bin (env "CLAUDE_BIN" "claude")
        run-dir (get-in ctx [:run :dir])
        repo-root (pi-cli/runtime-cwd ctx state-id node)
        prompt-file (pi-cli/render-prompt! wf ctx state-id node)
        prompt-text (slurp prompt-file)
        session-name (pi-cli/session-name ctx state-id node)
        model (:model node)
        provider (:provider node)
        thinking (:thinking node)
        tools (comma-tools (:tools node))
        log (log-file ctx state-id)
        sess-dir (session-dir ctx)
        session-path (str (fs/path sess-dir (str session-name ".txt")))]
    (fs/create-dirs (fs/parent log))
    (fs/create-dirs sess-dir)
    (store/write-runtime-text! ctx session-path (str "claude-code session marker\n" session-name "\n"))
    (when provider
      (store/append-runtime-text! ctx log
                                  (str "WARNING: pinned :provider \"" provider "\" is ignored by the claude-code executor; "
                                       "this executor uses the `claude` CLI subscription auth, not an API provider.\n\n")))
    (when thinking
      (store/append-runtime-text! ctx log
                                  (str "WARNING: :thinking \"" thinking "\" has no direct claude-code mapping and is dropped.\n\n")))
    (let [_ (store/append-runtime-text! ctx log
                                        (str "PROVIDER: " (or provider "<subscription>") "\n"
                                             "MODEL: " (or model "<default>") "\n\n"
                                             "CWD: " repo-root "\n"
                                             "PROMPT_FILE: " prompt-file "\n"
                                             "SESSION: " session-name "\n\n"
                                             "STATUS: running\n\n"))
          cmd (cond-> [claude-bin "--print" "--dangerously-skip-permissions"]
                model (conj "--model" model)
                tools (into ["--allowedTools" tools]))
          ;; Feed the rendered prompt via stdin so argv length and shell
          ;; escaping are never a concern.
          extra-env {"AGENT_RUN_DIR" run-dir
                     "AGENT_STATE" (name state-id)
                     "AGENT_ATTEMPT" (str (get-in ctx [:run :attempt]))}
          git-user (get-in ctx [:run :git-user])
          git-env (when git-user
                    {"GIT_AUTHOR_NAME" (:name git-user)
                     "GIT_AUTHOR_EMAIL" (:email git-user)
                     "GIT_COMMITTER_NAME" (:name git-user)
                     "GIT_COMMITTER_EMAIL" (:email git-user)
                     "GIT_USER_NAME" (:name git-user)
                     "GIT_USER_EMAIL" (:email git-user)})
          proc (deref (p/process {:cmd cmd
                                  :dir repo-root
                                  :in prompt-text
                                  :out :string :err :string :continue true
                                  :extra-env (subenv-without-api-key
                                                (merge extra-env (or git-env {})))}))
          exit (:exit proc)
          out (str (:out proc))
          err (str (:err proc))]
      (store/append-runtime-text! ctx log
                                   (str "STATUS: exited " exit "\n\n"
                                        "STDOUT:\n" out "\n\nSTDERR:\n" err "\n"))
      (cond-> {:executor "claude-code"
               :ok (zero? exit)
               :exit-code exit
               :prompt-file prompt-file
               :log-file log
               :session-name session-name}
        provider (assoc :provider provider)
        model (assoc :model model)
        thinking (assoc :thinking thinking)))))