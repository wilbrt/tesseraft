(ns tesseraft.control-plane.cli
  (:require
    [tesseraft.cli-args :as cli-args]
    [tesseraft.control-plane.core :as control-plane]
    [tesseraft.control-plane.doctor :as doctor]
    [cheshire.core :as json]
    [clojure.string :as str]))

;; Top-level options (`--workspace-root`, `--workflow-root`,
;; `--tesseraft-home`, `--runs-root`) are ONLY consumed *before* the command
;; is set. This matches all existing usage, which places these flags before
;; the command (e.g. `control-plane --workspace-root <root> workflows`).
;; Crucially, it also disambiguates the `project create|update` subcommands,
;; whose own `--workspace-root`/`--runs-root`/`--workflow-root` flags are
;; *project-spec* values (written into `.tesseraft/projects/<id>.json`), not
;; control-plane workspace overrides. Without this ordering, those flags were
;; greedily stolen as top-level options, relocating manifest writes outside
;; the workspace and bypassing path-confinement validation.
(defn parse-args [args]
  (loop [xs args acc {:command nil :args [] :workspace-root "." :workflow-roots ["examples"] :tesseraft-home nil :runs-root ".agent-runs" :project-id nil :project-root nil}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs
            rest-xs (rest xs)]
        (if (:command acc)
          ;; Command is fixed: every remaining token is a command argument,
          ;; including any that look like top-level options.
          (recur rest-xs (update acc :args conj a))
          (case a
            "--workspace-root" (recur more (assoc acc :workspace-root (cli-args/require-value a b)))
            "--workflow-root" (recur more (update acc :workflow-roots conj (cli-args/require-value a b)))
            "--tesseraft-home" (recur more (assoc acc :tesseraft-home (cli-args/require-value a b)))
            "--runs-root" (recur more (assoc acc :runs-root (cli-args/require-value a b)))
            "--project-id" (recur more (assoc acc :project-id (cli-args/require-value a b)))
            "--project-root" (recur more (assoc acc :project-root (cli-args/require-value a b)))
            (recur rest-xs (assoc acc :command a))))))))

(defn usage! []
  (binding [*out* *err*]
    (println "Usage:")
    (println "  tesseraft control-plane workflows")
    (println "  tesseraft control-plane workflow <name>")
    (println "  tesseraft control-plane graph <name>")
    (println "  tesseraft control-plane runs")
    (println "  tesseraft control-plane run <run-id>")
    (println "  tesseraft control-plane delete-run <run-id>")
    (println "  tesseraft control-plane events <run-id>")
    (println "  tesseraft control-plane artifacts <run-id>")
    (println "  tesseraft control-plane artifact <run-id> <path>")
    (println "  tesseraft control-plane approvals <run-id>")
    (println "  tesseraft control-plane approval <run-id> <approval-id>")
    (println "  tesseraft control-plane comments <run-id> --path <artifact>")
    (println "  tesseraft control-plane comment add <run-id> --path <artifact> --body <text> [--start-line N --end-line M]")
    (println "  tesseraft control-plane projects")
    (println "  tesseraft control-plane project <project-id>")
    (println "  tesseraft control-plane project create <project-id> [--name <name>] [--workspace-root <dir>] [--runs-root <dir>]")
    (println "  tesseraft control-plane project update <project-id> [--name <name>] [--workspace-root <dir>] [--runs-root <dir>]")
    (println "  tesseraft control-plane project migrate [<project-id>]")
    (println "  tesseraft control-plane project connections <project-id>")
    (println "  tesseraft control-plane doctor")
    (println)
    (println "Options:")
    (println "  --workspace-root <dir>   Workspace root (default: .)")
    (println "  --workflow-root <dir>    Additional workflow root (default: examples)")
    (println "  --tesseraft-home <dir>   Global Tesseraft directory (default: $TESSERAFT_HOME or ~/.tesseraft)")
    (println "  --runs-root <dir>        Runs root (default: .agent-runs)")
    (println "  --project-root <dir>     Explicit local project root containing .tesseraft/project.json"))
  (System/exit 2))

(defn require-arg [opts label]
  (or (first (:args opts))
      (throw (ex-info (str "Missing " label) {:label label}))))

(def ^:private git-user-missing ::missing)

(defn parse-git-user-set-args [args]
  (loop [xs args acc {:name git-user-missing :email git-user-missing :global false}]
    (if (empty? xs)
      acc
      (let [a (first xs)]
        (condp = a
          "--name" (recur (drop 2 xs) (assoc acc :name (second xs)))
          "--email" (recur (drop 2 xs) (assoc acc :email (second xs)))
          "--global" (recur (rest xs) (assoc acc :global true))
          (recur (rest xs) acc))))))

(defn git-user-command [options args project-id]
  (let [[sub & rest] (if (empty? args) ["get"] args)]
    (case sub
      "get" (control-plane/get-git-user options project-id)
      "set" (let [p (parse-git-user-set-args rest)]
             (if (or (= git-user-missing (:name p))
                     (= git-user-missing (:email p))
                     (nil? (:name p))
                     (nil? (:email p)))
               (control-plane/error-response 400 "bad_request" "git-user set requires --name and --email")
             (control-plane/set-git-user options (:name p) (:email p) (:global p) project-id)))
      (control-plane/error-response 400 "bad_request" (str "Unknown git-user subcommand: " sub)))))

(def ^:private settings-flags
  {"--pi-default-provider" :pi_default_provider
   "--pi-default-model" :pi_default_model
   "--github-token" :github_token
   "--jira-token" :jira_token
   "--default-repo-root" :default_repo_root
   "--color-scheme" :color_scheme})

(def ^:private settings-clear-flags
  {"--clear-pi-default-provider" :pi_default_provider
   "--clear-pi-default-model" :pi_default_model
   "--clear-github-token" :github_token
   "--clear-jira-token" :jira_token
   "--clear-default-repo-root" :default_repo_root})

(defn parse-settings-set-args [args]
  (loop [xs args acc {} global false]
    (if (empty? xs)
      {:updates acc :global global}
      (let [a (first xs)]
        (cond
          (= a "--global") (recur (rest xs) acc true)
          (contains? settings-clear-flags a)
          (recur (rest xs) (assoc acc (get settings-clear-flags a) nil) global)
          (contains? settings-flags a)
          (let [v (second xs)]
            (if (nil? v)
              (throw (ex-info (str "Missing value for " a) {:flag a}))
              (recur (drop 2 xs) (assoc acc (get settings-flags a) v) global)))
          :else (recur (rest xs) acc global))))))

(defn settings-command [options args project-id]
  (let [[sub & rest] (if (empty? args) ["get"] args)]
    (case sub
      "get" (control-plane/get-settings options project-id)
      "set" (let [parsed (try (parse-settings-set-args rest)
                              (catch Throwable t
                                {:error t}))]
              (if-let [err (:error parsed)]
                (control-plane/error-response 400 "bad_request" (.getMessage err))
                (control-plane/set-settings options (:updates parsed) (:global parsed) project-id)))
      (control-plane/error-response 400 "bad_request" (str "Unknown settings subcommand: " sub)))))

(defn require-nth-arg [opts idx label]
  (or (nth (:args opts) idx nil)
      (throw (ex-info (str "Missing " label) {:label label}))))

(defn parse-comment-add-args [args]
  (loop [xs args acc {:path nil :body nil :start-line nil :end-line nil}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs]
        (case a
          "--path" (recur more (assoc acc :path b))
          "--body" (recur more (assoc acc :body b))
          "--start-line" (recur more (assoc acc :start-line (parse-long b)))
          "--end-line" (recur more (assoc acc :end-line (parse-long b)))
          (recur (rest xs) acc))))))

(defn parse-project-create-args [args]
  (loop [xs args acc {:spec {}}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs]
        (case a
          "--name" (recur more (assoc-in acc [:spec :name] b))
          "--workspace-root" (recur more (assoc-in acc [:spec :workspace_root] b))
          "--runs-root" (recur more (assoc-in acc [:spec :runs_root] b))
          "--workflow-root" (let [roots (get-in acc [:spec :discovery :workflow-roots] [])]             (recur more (assoc-in acc [:spec :discovery :workflow-roots] (conj roots b))))
          "--tesseraft-home" (recur more (assoc-in acc [:spec :discovery :tesseraft-home] b))
          "--jira-base-url" (recur more (assoc-in acc [:spec :connections :jira :base-url] b))
          "--jira-credential-ref" (recur more (assoc-in acc [:spec :connections :jira :credential-ref] b))
          "--github-credential-ref" (recur more (assoc-in acc [:spec :connections :github :credential-ref] b))
          "--source" (recur more (assoc-in acc [:spec :source] b))
          (recur (rest xs) acc))))))

(defn parse-project-connections-args [args]
  (loop [xs args acc {}]
    (if (empty? xs)
      acc
      (let [[a b & more] xs]
        (case a
          "--jira-base-url" (recur more (assoc-in acc [:jira :base-url] b))
          "--jira-credential-ref" (recur more (assoc-in acc [:jira :credential-ref] b))
          "--github-credential-ref" (recur more (assoc-in acc [:github :credential-ref] b))
          (recur (rest xs) acc))))))

(defn project-command [options args]
  (let [[sub & rest] (if (empty? args) ["list"] args)]
    (case sub
      "create" (let [[project-id & more] rest]
                  (if (str/blank? project-id)
                    (control-plane/error-response 400 "bad_request" "project create requires <project-id>")
                    (control-plane/create-project options project-id (:spec (parse-project-create-args more)))))
      "update" (let [[project-id & more] rest]
                 (if (str/blank? project-id)
                   (control-plane/error-response 400 "bad_request" "project update requires <project-id>")
                   (control-plane/update-project options project-id (:spec (parse-project-create-args more)))))
      "migrate" (let [pid (first rest)]
                  (control-plane/migrate-project options (or pid "default")))
      "connections" (let [[project-id & more] rest]
                      (if (str/blank? project-id)
                        (control-plane/error-response 400 "bad_request" "project connections requires <project-id>")
                        (if (empty? (remove nil? more))
                          (control-plane/get-project-connections options project-id)
                          (control-plane/update-project-connections options project-id
                            (parse-project-connections-args more)))))
      ;; The aggregate list/detail also accepts ``projects`` form below; here
      ;; ``project`` without a sub or with an id is a detail.
      (if (some #(#{"-h" "--help" "help" "list" "ls"} %) [sub])
        (control-plane/list-projects options)
        (control-plane/get-project options sub)))))

(defn projects-command [options _args]
  (control-plane/list-projects options))

(defn exit-status [result]
  (if (:error result) 1 0))

(defn print-json! [result]
  (println (json/generate-string result {:pretty true})))

(defn -main [& args]
  (try
    (let [opts (parse-args args)
          command (:command opts)
          project-id (:project-id opts)
          options (select-keys opts [:workspace-root :workflow-roots :tesseraft-home :runs-root :project-id :project-root])
          result (case command
                   "workflows" (control-plane/list-workflows options project-id)
                   "workflow" (control-plane/get-workflow options (require-arg opts "workflow name") project-id)
                   "graph" (control-plane/get-workflow-graph options (require-arg opts "workflow name") project-id)
                   "runs" (control-plane/list-runs options project-id)
                   "run" (control-plane/get-run options (require-arg opts "run id") project-id)
                   "delete-run" (control-plane/delete-run options (require-arg opts "run id") project-id)
                   "events" (control-plane/get-run-events options (require-arg opts "run id") project-id)
                   "artifacts" (control-plane/get-run-artifacts options (require-arg opts "run id") project-id)
                   "artifact" (control-plane/read-run-artifact options (require-arg opts "run id") (require-nth-arg opts 1 "artifact path") project-id)
                   "approvals" (control-plane/get-run-approvals options (require-arg opts "run id") project-id)
                   "approval" (control-plane/get-run-approval options (require-arg opts "run id") (require-nth-arg opts 1 "approval id") project-id)
                   "comments" (let [run-id (require-arg opts "run id")
                                     path (some #(when (re-find #"^--path$" (first %)) (second %))
                                               (partition 2 1 (:args opts)))]
                               (control-plane/get-run-comments (assoc options :query {:path (or path "")}) run-id project-id))
                   "comment" (let [[sub & rest-args] (:args opts)]
                              (if (not= "add" sub)
                                (control-plane/error-response 400 "bad_request" (str "Unknown comment subcommand: " sub))
                                (let [run-id (first rest-args)
                                      p (parse-comment-add-args (rest rest-args))
                                      anchor (when (and (:start-line p) (:end-line p))
                                              {:start_line (:start-line p) :end_line (:end-line p)})
                                      body {:path (:path p) :body (:body p) :anchor anchor}]
                                  (if (or (str/blank? run-id) (str/blank? (:path p)) (str/blank? (:body p)))
                                    (control-plane/error-response 400 "bad_request" "comment add requires <run-id> --path <artifact> --body <text>")
                                    (control-plane/add-run-comment options run-id body project-id)))))
                   "git-user" (git-user-command options (:args opts) project-id)
                   "settings" (settings-command options (:args opts) project-id)
                   "doctor" (doctor/doctor-report options project-id)
                   "projects" (projects-command options (:args opts))
                   "project" (project-command options (:args opts))
                   (usage!))]

      (print-json! result)
      (when (not= 0 (exit-status result))
        (System/exit (exit-status result))))
    (catch Throwable t
      (binding [*out* *err*]
        (println (.getMessage t)))
      (System/exit 2))))
