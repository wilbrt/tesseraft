(ns tesseraft.executors.pi-cli
  (:require
    [tesseraft.spec :as spec]
    [tesseraft.executors.context :as executor-context]
    [tesseraft.executors.process :as executor-process]
    [tesseraft.runtime.store :as store]
    [babashka.fs :as fs]
    [clojure.string :as str]))

(defn env [k default] (or (System/getenv k) default))
(defn comma-tools [tools] (when (seq tools) (->> tools (map name) (str/join ","))))

(def execution-context executor-context/execution-context)

(def render-prompt! executor-context/render-prompt!)

(defn session-name
  ([ctx state-id node] (executor-context/session-name nil ctx state-id node))
  ([wf ctx state-id node] (executor-context/session-name wf ctx state-id node)))

(def runtime-cwd executor-context/runtime-cwd)

(defn run-agent-node! [wf ctx state-id node]
  (let [pi-bin (env "PI_BIN" "pi")
        run-dir (get-in ctx [:run :dir])
        repo-root (runtime-cwd ctx state-id node)
        prompt-file (render-prompt! wf ctx state-id node)
        session-dir (str (fs/path run-dir "pi-sessions"))
        session-name (session-name wf ctx state-id node)
        tools (comma-tools (:tools node))
        provider (:provider node)
        model (:model node)
        thinking (:thinking node)
        log-file (str (fs/path run-dir "logs" (str (name state-id) "-" (get-in ctx [:run :attempt]) ".log")))
        args (cond-> [pi-bin "--approve" "--session-dir" session-dir "--name" session-name]
               tools (into ["--tools" tools])
               provider (into ["--provider" provider])
               model (into ["--model" model])
               thinking (into ["--thinking" thinking])
               true (into ["-p" (str "@" prompt-file)]))]
    (fs/create-dirs (fs/parent log-file))
    ;; Pi owns credential resolution, including ~/.pi/agent/auth.json written by
    ;; /login and provider environment variables used by headless runs.
    (store/write-runtime-text! ctx log-file
                               (str "COMMAND: " (str/join " " args) "\n\n"
                                    "CWD: " repo-root "\n\n"
                                    "PROVIDER: " (or provider "<default>") "\n"
                                    "MODEL: " (or model "<default>") "\n"
                                    "THINKING: " (or thinking "<default>") "\n\n"
                                    "PROMPT_FILE: " prompt-file "\n\n"
                                    "STATUS: running\n\n"))
    ;; Pi print mode reads non-TTY stdin before processing its prompt, so send
    ;; an empty input explicitly to close the subprocess pipe with EOF.
    (let [result (executor-process/run! {:cmd args :dir repo-root :input ""
                                         :env (executor-context/agent-env ctx state-id)})]
      (store/append-runtime-text! ctx log-file
                                  (str "STATUS: exited " (:exit-code result) "\n\n"
                                       "STDOUT:\n" (:stdout result) "\n\nSTDERR:\n" (:stderr result) "\n"))
      (cond-> (merge (select-keys result [:ok :status :category :code :message])
                     {:executor "pi-cli"
                      :exit-code (:exit-code result)
                      :prompt-file prompt-file
                      :log-file log-file
                      :session-name session-name})
        provider (assoc :provider provider)
        model (assoc :model model)
        thinking (assoc :thinking thinking)))))

(defn- redacted-session-command [args]
  (loop [remaining args result []]
    (if-let [arg (first remaining)]
      (if (contains? #{"--session" "--session-id"} arg)
        (recur (nnext remaining) (conj result arg "<session-ref>"))
        (recur (next remaining) (conj result arg)))
      result)))

(defn run-agent-session-node! [wf ctx state-id node request]
  (let [pi-bin (env "PI_BIN" "pi")
        run-dir (get-in ctx [:run :dir])
        repo-root (runtime-cwd ctx state-id node)
        prompt-file (:prompt-file request)
        session-dir (str (fs/path run-dir "pi-sessions"))
        session-name (session-name wf ctx state-id node)
        session-ref (get-in request [:session-ref :value])
        operation (:operation request)
        tools (comma-tools (:tools node))
        provider (:provider node)
        model (:model node)
        thinking (:thinking node)
        log-file (str (fs/path run-dir "logs"
                               (str (name state-id) "-" (get-in ctx [:run :attempt]) ".log")))
        base [pi-bin "--approve" "--session-dir" session-dir]
        args (cond-> (case operation
                       :start (into base ["--session-id" session-ref "--name" session-name])
                       :resume (into base ["--session" session-ref])
                       (throw (ex-info "Unsupported Pi session operation"
                                       {:operation operation
                                        :error-type "executor_session_operation_invalid"})))
               tools (into ["--tools" tools])
               provider (into ["--provider" provider])
               model (into ["--model" model])
               thinking (into ["--thinking" thinking])
               true (into ["-p" (str "@" prompt-file)]))]
    (fs/create-dirs (fs/parent log-file))
    (store/write-runtime-text!
      ctx log-file
      (str "COMMAND: " (str/join " " (redacted-session-command args)) "\n\n"
           "CWD: " repo-root "\n\n"
           "PROVIDER: " (or provider "<default>") "\n"
           "MODEL: " (or model "<default>") "\n"
           "THINKING: " (or thinking "<default>") "\n"
           "SESSION_OPERATION: " (name operation) "\n"
           "SESSION_REF_SHA256: " (store/sha256 session-ref) "\n"
           "DELIVERY_ID: " (:delivery-id request) "\n\n"
           "PROMPT_FILE: " prompt-file "\n\n"
           "STATUS: running\n\n"))
    (let [result (executor-process/run! {:cmd args :dir repo-root :input ""
                                         :env (executor-context/agent-env ctx state-id)})]
      (store/append-runtime-text! ctx log-file
                                  (str "STATUS: exited " (:exit-code result) "\n\n"
                                       "STDOUT:\n" (:stdout result) "\n\nSTDERR:\n" (:stderr result) "\n"))
      (cond-> (merge (select-keys result [:ok :status :category :code :message])
                     {:executor "pi-cli"
                      :exit-code (:exit-code result)
                      :prompt-file prompt-file
                      :log-file log-file
                      :session-name session-name
                      :session-ref (:session-ref request)})
        provider (assoc :provider provider)
        model (assoc :model model)
        thinking (assoc :thinking thinking)))))
