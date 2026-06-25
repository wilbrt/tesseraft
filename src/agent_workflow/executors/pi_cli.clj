(ns agent-workflow.executors.pi-cli
  (:require
    [agent-workflow.spec :as spec]
    [agent-workflow.runtime.store :as store]
    [babashka.fs :as fs]
    [babashka.process :as p]
    [clojure.string :as str]))

(defn env [k default] (or (System/getenv k) default))
(defn comma-tools [tools] (when (seq tools) (->> tools (map name) (str/join ","))))

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

(defn run-agent-node! [wf ctx state-id node]
  (let [pi-bin (env "PI_BIN" "pi")
        run-dir (get-in ctx [:run :dir])
        repo-root (or (get-in ctx [:inputs :repo-root]) (get-in ctx [:inputs :repo]) ".")
        prompt-file (render-prompt! wf ctx state-id node)
        session-dir (str (fs/path run-dir "pi-sessions"))
        session-name (session-name ctx state-id node)
        tools (comma-tools (:tools node))
        log-file (str (fs/path run-dir "logs" (str (name state-id) "-" (get-in ctx [:run :attempt]) ".log")))
        args (cond-> [pi-bin "--approve" "--session-dir" session-dir "--name" session-name]
               tools (into ["--tools" tools])
               true (into ["-p" (str "@" prompt-file)]))
        result (apply p/shell {:dir repo-root
                               :out :string :err :string :continue true
                               :extra-env {"AGENT_RUN_DIR" run-dir
                                           "AGENT_STATE" (name state-id)
                                           "AGENT_ATTEMPT" (str (get-in ctx [:run :attempt]))}}
                      args)]
    (fs/create-dirs (fs/parent log-file))
    (spit log-file
          (str "COMMAND: " (str/join " " args) "\n\n"
               "PROMPT_FILE: " prompt-file "\n\n"
               "STDOUT:\n" (:out result) "\n\nSTDERR:\n" (:err result) "\n"))
    {:executor "pi-cli"
     :ok (zero? (:exit result))
     :exit-code (:exit result)
     :prompt-file prompt-file
     :log-file log-file
     :session-name session-name}))
