(ns tesseraft.capabilities.executors
  (:require [babashka.fs :as fs]))

(defn- executable-availability [env-name fallback]
  (let [configured (System/getenv env-name)
        executable (or configured fallback)
        found (if configured
                (and (fs/exists? configured) (fs/executable? configured))
                (some? (fs/which fallback)))]
    (if found
      {:status "ready" :executable executable}
      {:status "unavailable" :reason (str executable " executable was not found")})))

(defn pi-cli-availability [] (executable-availability "PI_BIN" "pi"))
(defn claude-code-availability [] (executable-availability "CLAUDE_BIN" "claude"))
(defn opencode-cli-availability [] (executable-availability "OPENCODE_BIN" "opencode"))
(defn pi-sdk-availability []
  {:status "unavailable" :reason "The Pi SDK executor is not implemented"})

(def descriptors
  {:pi-cli
   {:id :pi-cli :label "Pi CLI" :run 'tesseraft.executors.pi-cli/run-agent-node!
    :availability pi-cli-availability :config-schema {}
    :credential-requirements [] :supports-session-resume? true
    :experimental? false :dispatchable? true}
   :claude-code
   {:id :claude-code :label "Claude Code CLI" :run 'tesseraft.executors.claude-code/run-agent-node!
    :availability claude-code-availability :config-schema {}
    :credential-requirements [] :supports-session-resume? false
    :experimental? false :dispatchable? true}
   :opencode-cli
   {:id :opencode-cli :label "OpenCode CLI" :run 'tesseraft.executors.opencode-cli/run-agent-node!
    :availability opencode-cli-availability :config-schema {}
    :credential-requirements [] :supports-session-resume? false
    :experimental? false :dispatchable? true}
   :pi-sdk
   {:id :pi-sdk :label "Pi SDK" :run nil
    :availability pi-sdk-availability :config-schema {}
    :credential-requirements [] :supports-session-resume? false
    :experimental? true :dispatchable? false}})

(defn ids [] (set (keys descriptors)))
(defn descriptor [id] (get descriptors id))
(defn dispatchable? [id] (true? (:dispatchable? (descriptor id))))
(defn supports-session-resume? [id]
  (true? (:supports-session-resume? (descriptor id))))

(defn invoke! [id & args]
  (if-let [symbol (:run (descriptor id))]
    (apply (requiring-resolve symbol) args)
    (throw (ex-info "Unknown or unavailable agent executor"
                    {:executor id :error-type "executor_unavailable"}))))

(defn public-descriptors []
  (mapv (fn [{:keys [availability] :as descriptor}]
          (-> descriptor
              (dissoc :run :availability)
              (assoc :availability (availability))))
        (sort-by (comp name :id) (vals descriptors))))
