(ns tesseraft.capabilities.handlers)

;; The descriptor map is the sole inventory for built-in deterministic
;; handlers. Implementations are symbols so lint/catalog consumers do not load
;; runtime integration namespaces; dispatch resolves the symbol only at use.
(def descriptors
  {:work-tracker/fetch-item
   {:id :work-tracker/fetch-item :label "Fetch work item"
    :run 'tesseraft.work-tracker.runtime/fetch-item!
    :mock 'tesseraft.work-tracker.runtime/mock-fetch-item!
    :allowed-node-types #{:deterministic}
    :side-effects #{:filesystem :network} :deprecated? false}
   :git/ensure-branch
   {:id :git/ensure-branch :label "Ensure Git branch"
    :run 'tesseraft.handlers.git/git-ensure-branch!
    :mock 'tesseraft.handlers.git/mock-git-ensure-branch!
    :allowed-node-types #{:deterministic}
    :side-effects #{:filesystem :process :network} :deprecated? false}
   :git/ensure-worktree
   {:id :git/ensure-worktree :label "Ensure Git worktree"
    :run 'tesseraft.handlers.git/git-ensure-worktree!
    :mock 'tesseraft.handlers.git/mock-git-ensure-worktree!
    :allowed-node-types #{:deterministic}
    :side-effects #{:filesystem :process :network} :deprecated? false}
   :git/push
   {:id :git/push :label "Push Git branch"
    :run 'tesseraft.handlers.git/git-push!
    :mock 'tesseraft.handlers.git/mock-git-push!
    :allowed-node-types #{:deterministic}
    :side-effects #{:process :network} :deprecated? false}
   :github/create-pr
   {:id :github/create-pr :label "Create GitHub pull request"
    :run 'tesseraft.handlers.github/github-create-pr!
    :mock 'tesseraft.handlers.github/mock-github-create-pr!
    :allowed-node-types #{:deterministic}
    :side-effects #{:filesystem :process :network} :deprecated? false}
   :github/fetch-pr-feedback
   {:id :github/fetch-pr-feedback :label "Fetch GitHub PR feedback"
    :run 'tesseraft.handlers.github/github-fetch-pr-feedback!
    :mock 'tesseraft.handlers.github/mock-github-fetch-pr-feedback!
    :allowed-node-types #{:deterministic}
    :side-effects #{:filesystem :process :network} :deprecated? false}
   :web/start-test-server
   {:id :web/start-test-server :label "Start test server"
    :run 'tesseraft.handlers.web/start-test-server!
    :mock 'tesseraft.handlers.web/mock-start-test-server!
    :allowed-node-types #{:deterministic}
    :side-effects #{:filesystem :process :network} :deprecated? false}
   :web/stop-test-server
   {:id :web/stop-test-server :label "Stop test server"
    :run 'tesseraft.handlers.web/stop-test-server!
    :mock 'tesseraft.handlers.web/mock-stop-test-server!
    :allowed-node-types #{:deterministic}
    :side-effects #{:filesystem :process} :deprecated? false}
   :web/capture-ui-evidence
   {:id :web/capture-ui-evidence :label "Capture UI evidence"
    :run 'tesseraft.handlers.web/capture-ui-evidence!
    :mock 'tesseraft.handlers.web/mock-capture-ui-evidence!
    :allowed-node-types #{:deterministic}
    :side-effects #{:filesystem :process} :deprecated? false}
   :web/validate-ui-review
   {:id :web/validate-ui-review :label "Validate UI review"
    :run 'tesseraft.handlers.web/validate-ui-review!
    :mock 'tesseraft.handlers.web/mock-validate-ui-review!
    :allowed-node-types #{:deterministic}
    :side-effects #{:filesystem} :deprecated? false}
   :git/publish-visual-evidence
   {:id :git/publish-visual-evidence :label "Publish visual evidence"
    :run 'tesseraft.handlers.web/publish-visual-evidence!
    :mock 'tesseraft.handlers.web/mock-publish-visual-evidence!
    :allowed-node-types #{:deterministic}
    :side-effects #{:filesystem :process :network} :deprecated? false}
   :notify/pinga
   {:id :notify/pinga :label "Notify with Pinga"
    :run 'tesseraft.handlers.notify/notify-pinga!
    :mock 'tesseraft.handlers.notify/mock-notify-pinga!
    :availability 'tesseraft.handlers.notify/availability
    :allowed-node-types #{:deterministic}
    :side-effects #{:process} :deprecated? false}
   :noop/succeed
   {:id :noop/succeed :label "Succeed without effects"
    :run 'tesseraft.handlers.noop/noop-succeed!
    :mock 'tesseraft.handlers.noop/mock-noop-succeed!
    :allowed-node-types #{:deterministic}
    :side-effects #{} :deprecated? false}})

(defn ids [] (set (keys descriptors)))
(defn descriptor [id] (get descriptors id))

(defn implementation [id mode]
  (when-let [symbol (get (descriptor id) mode)]
    (requiring-resolve symbol)))

(defn invoke! [id mode & args]
  (if-let [f (implementation id mode)]
    (apply f args)
    (throw (ex-info (str "Unknown deterministic handler: " id)
                    {:handler id :mode mode :error-type "unknown_handler"}))))

(defn public-descriptors []
  (mapv #(let [availability (:availability %)
               public (-> %
                          (dissoc :run :mock :availability)
                          (update :id (fn [id] (subs (str id) 1))))]
           (assoc public :availability
                  (if availability
                    ((requiring-resolve availability))
                    {:status "ready"})))
        (sort-by (comp str :id) (vals descriptors))))
