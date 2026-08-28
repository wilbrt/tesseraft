(ns tesseraft.executors.opencode-cli
  "Agent executor for OpenCode's non-interactive CLI.

  Each invocation uses a dedicated primary agent whose permissions are derived
  from the workflow node's `:tools`. Project configuration, user configuration,
  external plugins, and Claude Code compatibility loading are disabled so they
  cannot broaden that tool ceiling. OpenCode's own auth store and provider
  environment variables remain available to the subprocess."
  (:require
    [babashka.fs :as fs]
    [cheshire.core :as json]
    [clojure.string :as str]
    [tesseraft.executors.context :as executor-context]
    [tesseraft.executors.process :as executor-process]
    [tesseraft.runtime.store :as store]))

(defn env [k default] (or (System/getenv k) default))

(def ^:private tool-name
  {:read "read"
   :bash "bash"
   :edit "edit"
   :write "edit"
   :grep "grep"
   :find "glob"
   :ls "list"})

(defn- resolved-model [{:keys [provider model]}]
  (cond
    (and provider model (str/includes? model "/")) model
    (and provider model) (str provider "/" model)
    model model
    :else nil))

(defn- permission-map [tools]
  (let [enabled (->> tools (keep tool-name) distinct vec)]
    ;; OpenCode permission rules use last-match-wins semantics, so the wildcard
    ;; must be serialized before the specific grants. Tesseraft has seven
    ;; unique mapped tools, keeping this at Clojure's eight-entry array-map
    ;; limit and therefore preserving insertion order during JSON generation.
    (apply array-map
           (mapcat identity
                   (concat [["*" "deny"]]
                           (map (fn [tool] [tool "allow"]) enabled))))))

(defn- config-content [tools]
  (json/generate-string
    {"agent"
     {"tesseraft"
      {"description" "Tesseraft workflow agent"
       "mode" "primary"
       "permission" (permission-map tools)}}}))

(defn- invocation-command
  [opencode-bin repo-root session-name selected-model thinking resume-session-id]
  (cond-> [opencode-bin "run"
           "--format" "json"
           "--title" session-name
           "--dir" repo-root
           "--agent" "tesseraft"
           "--pure"
           "--dangerously-skip-permissions"]
    resume-session-id (into ["--session" resume-session-id])
    selected-model (into ["--model" selected-model])
    thinking (into ["--variant" thinking])))

(defn- invocation-env [ctx state-id config-home tools]
  (merge
    (executor-context/agent-env ctx state-id)
    {"XDG_CONFIG_HOME" config-home
     "OPENCODE_CONFIG" nil
     "OPENCODE_CONFIG_DIR" nil
     "OPENCODE_PERMISSION" nil
     "OPENCODE_DISABLE_PROJECT_CONFIG" "true"
     "OPENCODE_DISABLE_CLAUDE_CODE" "true"
     "OPENCODE_DISABLE_AUTOUPDATE" "true"
     "OPENCODE_CONFIG_CONTENT" (config-content tools)}))

(defn- invocation-dir [ctx state-id]
  (str (fs/path (get-in ctx [:run :dir]) "opencode-sessions"
                (str (name state-id) "-" (get-in ctx [:run :attempt])))))

(defn- parse-events [text]
  (reduce
    (fn [{:keys [events] :as result} line]
      (if (str/blank? line)
        result
        (try
          (update result :events conj (json/parse-string line true))
          (catch Throwable _
            (update result :malformed inc)))))
    {:events [] :malformed 0}
    (str/split-lines (or text ""))))

(defn- event-session-id-value [event]
  (let [candidate (or (:sessionID event)
                      (:sessionId event)
                      (:session_id event)
                      (get-in event [:part :sessionID])
                      (get-in event [:part :sessionId])
                      (get-in event [:part :session_id]))]
    (when (and (string? candidate) (not (str/blank? candidate)))
      candidate)))

(defn- event-session-ids [events]
  (->> events (keep event-session-id-value) distinct vec))

(defn- event-session-id [events]
  (first (event-session-ids events)))

(defn- last-event-value [events key]
  (some (fn [event]
          (or (get-in event [:part key]) (get event key)))
        (reverse events)))

(defn- redacted-session-command [command]
  (loop [remaining command redacted []]
    (if-let [argument (first remaining)]
      (if (= "--session" argument)
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
  (let [opencode-bin (env "OPENCODE_BIN" "opencode")
        run-dir (get-in ctx [:run :dir])
        repo-root (executor-context/runtime-cwd ctx state-id node)
        prompt-file (executor-context/render-prompt! wf ctx state-id node)
        prompt-text (slurp prompt-file)
        session-name (executor-context/session-name wf ctx state-id node)
        provider (:provider node)
        model (:model node)
        selected-model (resolved-model node)
        thinking (:thinking node)
        invoke-dir (invocation-dir ctx state-id)
        config-home (str (fs/path invoke-dir "config"))
        events-file (str (fs/path invoke-dir "events.jsonl"))
        log-file (str (fs/path run-dir "logs"
                               (str (name state-id) "-opencode-cli-"
                                    (get-in ctx [:run :attempt]) ".log")))
        command (invocation-command opencode-bin repo-root session-name
                                    selected-model thinking nil)
        process-env (invocation-env ctx state-id config-home (:tools node))]
    (fs/create-dirs config-home)
    (fs/create-dirs (fs/parent log-file))
    (store/write-runtime-text!
      ctx log-file
      (str "COMMAND: " (str/join " " command) "\n\n"
           "CWD: " repo-root "\n"
           "PROVIDER: " (or provider "<default>") "\n"
           "MODEL: " (or model "<default>") "\n"
           "RESOLVED_MODEL: " (or selected-model "<default>") "\n"
           "VARIANT: " (or thinking "<default>") "\n"
           "PROMPT_FILE: " prompt-file "\n"
           "EVENTS_FILE: " events-file "\n"
           "SESSION: " session-name "\n\n"
           "STATUS: running\n\n"))
    (let [proc (executor-process/run! {:cmd command
                                       :dir repo-root
                                       :input prompt-text
                                       :env process-env})
          output (:stdout proc)
          {:keys [events malformed]} (parse-events output)
          session-id (event-session-id events)
          tokens (last-event-value events :tokens)
          cost (last-event-value events :cost)]
      (store/write-runtime-text! ctx events-file output)
      (store/append-runtime-text!
        ctx log-file
        (str "STATUS: exited " (:exit-code proc) "\n"
             "EVENT_COUNT: " (count events) "\n"
             "MALFORMED_EVENT_COUNT: " malformed "\n"
             "SESSION_ID: " (or session-id "<unknown>") "\n\n"
             "STDERR:\n" (:stderr proc) "\n"))
      (cond-> (merge (select-keys proc [:ok :status :category :code :message])
                     {:executor "opencode-cli"
                      :exit-code (:exit-code proc)
                      :prompt-file prompt-file
                      :log-file log-file
                      :events-file events-file
                      :event-count (count events)
                      :malformed-event-count malformed
                      :session-name session-name})
        provider (assoc :provider provider)
        model (assoc :model model)
        selected-model (assoc :resolved-model selected-model)
        thinking (assoc :thinking thinking)
        session-id (assoc :session-id session-id)
        tokens (assoc :tokens tokens)
        (some? cost) (assoc :cost cost)))))

(defn run-agent-session-node! [wf ctx state-id node request]
  (let [opencode-bin (env "OPENCODE_BIN" "opencode")
        run-dir (get-in ctx [:run :dir])
        repo-root (executor-context/runtime-cwd ctx state-id node)
        prompt-file (:prompt-file request)
        prompt-text (slurp prompt-file)
        session-name (executor-context/session-name wf ctx state-id node)
        provider (:provider node)
        model (:model node)
        selected-model (resolved-model node)
        thinking (:thinking node)
        operation (:operation request)
        bound-session-id (get-in request [:session-ref :value])
        _ (when (and (= :resume operation) (str/blank? bound-session-id))
            (throw (ex-info "OpenCode resume requires an exact session reference"
                            {:operation operation
                             :error-type "executor_session_reference_missing"})))
        invoke-dir (invocation-dir ctx state-id)
        config-home (str (fs/path invoke-dir "config"))
        events-file (str (fs/path invoke-dir "events.jsonl"))
        log-file (str (fs/path run-dir "logs"
                               (str (name state-id) "-opencode-cli-"
                                    (get-in ctx [:run :attempt]) ".log")))
        resume-session-id (case operation
                            :start nil
                            :resume bound-session-id
                            (throw (ex-info "Unsupported OpenCode session operation"
                                            {:operation operation
                                             :error-type "executor_session_operation_invalid"})))
        command (invocation-command opencode-bin repo-root session-name
                                    selected-model thinking resume-session-id)
        process-env (invocation-env ctx state-id config-home (:tools node))]
    (fs/create-dirs config-home)
    (fs/create-dirs (fs/parent log-file))
    (store/write-runtime-text!
      ctx log-file
      (str "COMMAND: " (str/join " " (redacted-session-command command)) "\n\n"
           "CWD: " repo-root "\n"
           "PROVIDER: " (or provider "<default>") "\n"
           "MODEL: " (or model "<default>") "\n"
           "RESOLVED_MODEL: " (or selected-model "<default>") "\n"
           "VARIANT: " (or thinking "<default>") "\n"
           "PROMPT_FILE: " prompt-file "\n"
           "EVENTS_FILE: " events-file "\n"
           "SESSION: " session-name "\n"
           "SESSION_OPERATION: " (name operation) "\n"
           (when bound-session-id
             (str "SESSION_REF_SHA256: " (store/sha256 bound-session-id) "\n"))
           "DELIVERY_ID: " (:delivery-id request) "\n\n"
           "STATUS: running\n\n"))
    (let [proc (executor-process/run! {:cmd command
                                       :dir repo-root
                                       :input prompt-text
                                       :env process-env})
          output (:stdout proc)
          {:keys [events malformed]} (parse-events output)
          emitted-session-ids (event-session-ids events)
          emitted-session-id (first emitted-session-ids)
          tokens (last-event-value events :tokens)
          cost (last-event-value events :cost)]
      (store/write-runtime-text! ctx events-file output)
      (store/append-runtime-text!
        ctx log-file
        (str "STATUS: exited " (:exit-code proc) "\n"
             "EVENT_COUNT: " (count events) "\n"
             "MALFORMED_EVENT_COUNT: " malformed "\n"
             (when emitted-session-id
               (str "RETURNED_SESSION_REF_SHA256: " (store/sha256 emitted-session-id) "\n"))
             "\nSTDERR:\n"
             (redact-session-refs (:stderr proc)
                                  [bound-session-id emitted-session-id])
             "\n"))
      (when (> (count emitted-session-ids) 1)
        (throw (ex-info "OpenCode emitted conflicting session references"
                        {:error-type "executor_session_reference_ambiguous"
                         :operation operation})))
      (when (and (= :resume operation)
                 emitted-session-id
                 (not= bound-session-id emitted-session-id))
        (throw (ex-info "OpenCode resumed a different session than requested"
                        {:error-type "executor_session_reference_mismatch"
                         :operation operation})))
      (cond-> (merge (select-keys proc [:ok :status :category :code :message])
                     {:executor "opencode-cli"
                      :exit-code (:exit-code proc)
                      :prompt-file prompt-file
                      :log-file log-file
                      :events-file events-file
                      :event-count (count events)
                      :malformed-event-count malformed
                      :session-name session-name})
        provider (assoc :provider provider)
        model (assoc :model model)
        selected-model (assoc :resolved-model selected-model)
        thinking (assoc :thinking thinking)
        emitted-session-id (assoc :session-ref {:kind "id" :value emitted-session-id})
        tokens (assoc :tokens tokens)
        (some? cost) (assoc :cost cost)))))
