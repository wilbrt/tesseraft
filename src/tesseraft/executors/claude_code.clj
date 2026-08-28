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
  inspection; resumable mode selects exact `--session-id` and `--resume`
  references from Tesseraft's durable binding."
  (:require
    [cheshire.core :as json]
    [tesseraft.executors.context :as executor-context]
    [tesseraft.executors.process :as executor-process]
    [tesseraft.runtime.store :as store]
    [babashka.fs :as fs]
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

(defn- invocation-command [claude-bin node session-arguments]
  (let [model (:model node)
        tools (comma-tools (:tools node))]
    (cond-> (into [claude-bin "--print" "--dangerously-skip-permissions"]
                  session-arguments)
      model (into ["--model" model])
      tools (into ["--allowedTools" tools]))))

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

(defn- emitted-session-id [output]
  (try
    (let [result (json/parse-string (or output "") true)]
      (let [candidate (or (:session_id result) (:sessionId result) (:sessionID result))]
        (when (and (string? candidate) (not (str/blank? candidate)))
          candidate)))
    (catch Throwable _ nil)))

(defn- redacted-session-command [command]
  (loop [remaining command redacted []]
    (if-let [argument (first remaining)]
      (if (contains? #{"--session-id" "--resume"} argument)
        (recur (nnext remaining) (conj redacted argument "<session-ref>"))
        (recur (next remaining) (conj redacted argument)))
      redacted)))

(defn- redact-session-refs [text references]
  (reduce (fn [redacted reference]
            (if (and (string? reference) (not (str/blank? reference)))
              (str/replace redacted reference "<session-ref>")
              redacted))
          (or text "")
          references))

(defn run-agent-node! [wf ctx state-id node]
  (let [claude-bin (env "CLAUDE_BIN" "claude")
        run-dir (get-in ctx [:run :dir])
        repo-root (executor-context/runtime-cwd ctx state-id node)
        prompt-file (executor-context/render-prompt! wf ctx state-id node)
        prompt-text (slurp prompt-file)
        session-name (executor-context/session-name wf ctx state-id node)
        model (:model node)
        provider (:provider node)
        thinking (:thinking node)
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
          cmd (invocation-command claude-bin node [])
          ;; Feed the rendered prompt via stdin so argv length and shell
          ;; escaping are never a concern.
          proc (executor-process/run! {:cmd cmd :dir repo-root :input prompt-text
                                       :env (subenv-without-api-key
                                              (executor-context/agent-env ctx state-id))})
          exit (:exit-code proc)
          out (:stdout proc)
          err (:stderr proc)]
      (store/append-runtime-text! ctx log
                                   (str "STATUS: exited " exit "\n\n"
                                        "STDOUT:\n" out "\n\nSTDERR:\n" err "\n"))
      (cond-> (merge (select-keys proc [:ok :status :category :code :message])
                     {:executor "claude-code"
               :exit-code exit
               :prompt-file prompt-file
               :log-file log
               :session-name session-name})
        provider (assoc :provider provider)
        model (assoc :model model)
        thinking (assoc :thinking thinking)))))

(defn run-agent-session-node! [wf ctx state-id node request]
  (let [claude-bin (env "CLAUDE_BIN" "claude")
        run-dir (get-in ctx [:run :dir])
        repo-root (executor-context/runtime-cwd ctx state-id node)
        prompt-file (:prompt-file request)
        prompt-text (slurp prompt-file)
        session-name (executor-context/session-name wf ctx state-id node)
        session-ref (get-in request [:session-ref :value])
        operation (:operation request)
        model (:model node)
        provider (:provider node)
        thinking (:thinking node)
        log (log-file ctx state-id)
        sess-dir (session-dir ctx)
        session-path (str (fs/path sess-dir (str session-name ".txt")))
        _ (when (str/blank? session-ref)
            (throw (ex-info "Claude Code session operation requires an exact reference"
                            {:operation operation
                             :error-type "executor_session_reference_missing"})))
        session-arguments (case operation
                            :start ["--output-format" "json" "--session-id" session-ref]
                            :resume ["--output-format" "json" "--resume" session-ref]
                            (throw (ex-info "Unsupported Claude Code session operation"
                                            {:operation operation
                                             :error-type "executor_session_operation_invalid"})))
        command (invocation-command claude-bin node session-arguments)]
    (fs/create-dirs (fs/parent log))
    (fs/create-dirs sess-dir)
    (store/write-runtime-text! ctx session-path (str "claude-code session marker\n" session-name "\n"))
    (store/write-runtime-text!
      ctx log
      (str (when provider
             (str "WARNING: pinned :provider \"" provider
                  "\" is ignored by the claude-code executor; this executor uses "
                  "the `claude` CLI subscription auth, not an API provider.\n\n"))
           (when thinking
             (str "WARNING: :thinking \"" thinking
                  "\" has no direct claude-code mapping and is dropped.\n\n"))
           "COMMAND: " (str/join " " (redacted-session-command command)) "\n\n"
           "PROVIDER: " (or provider "<subscription>") "\n"
           "MODEL: " (or model "<default>") "\n"
           "CWD: " repo-root "\n"
           "PROMPT_FILE: " prompt-file "\n"
           "SESSION: " session-name "\n"
           "SESSION_OPERATION: " (name operation) "\n"
           "SESSION_REF_SHA256: " (store/sha256 session-ref) "\n"
           "DELIVERY_ID: " (:delivery-id request) "\n\n"
           "STATUS: running\n\n"))
    (let [proc (executor-process/run! {:cmd command
                                       :dir repo-root
                                       :input prompt-text
                                       :env (subenv-without-api-key
                                              (executor-context/agent-env ctx state-id))})
          reported-session-id (emitted-session-id (:stdout proc))]
      (store/append-runtime-text!
        ctx log
        (str "STATUS: exited " (:exit-code proc) "\n"
             (when reported-session-id
               (str "RETURNED_SESSION_REF_SHA256: " (store/sha256 reported-session-id) "\n"))
             "\nSTDOUT:\n"
             (redact-session-refs (:stdout proc) [session-ref reported-session-id])
             "\n\nSTDERR:\n"
             (redact-session-refs (:stderr proc) [session-ref reported-session-id]) "\n"))
      (when (and reported-session-id (not= session-ref reported-session-id))
        (throw (ex-info "Claude Code returned a different session than requested"
                        {:error-type "executor_session_reference_mismatch"
                         :operation operation})))
      (when (and (:ok proc) (str/blank? reported-session-id))
        (throw (ex-info "Claude Code did not return a structured session id"
                        {:error-type "executor_session_reference_missing"
                         :operation operation})))
      (cond-> (merge (select-keys proc [:ok :status :category :code :message])
                     {:executor "claude-code"
                      :exit-code (:exit-code proc)
                      :prompt-file prompt-file
                      :log-file log
                      :session-name session-name
                      :session-ref (:session-ref request)})
        provider (assoc :provider provider)
        model (assoc :model model)
        thinking (assoc :thinking thinking)))))
