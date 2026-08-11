(ns tesseraft.handlers.git
  (:require [babashka.fs :as fs]
            [babashka.process :as p]
            [clojure.string :as str]
            [tesseraft.handlers.common :as common]
            [tesseraft.runtime.store :as store]
            [tesseraft.spec :as spec]))

(def shell! common/shell!)
(def artifact-path common/artifact-path)
(def artifact-text common/artifact-text)
(def repo-dir common/repo-dir)
(def output-path common/output-path)

(defn render-command [ctx command-template] (spec/render-template-string command-template ctx))
(defn branch-name [ctx node]
  (or (not-empty (get-in ctx [:inputs :branch]))
      (not-empty (artifact-text ctx (get-in node [:inputs :branch-file])))
      (str "feature/" (str/lower-case
                        (or (get-in ctx [:inputs :item-id])
                            (get-in ctx [:inputs :work-item-id])
                            (get-in ctx [:workflow :name])
                            (get-in ctx [:run :id]))))))
(defn git-ref-candidates [ref]
  (cond
    (str/starts-with? ref "refs/") [ref]
    (str/starts-with? ref "origin/") [(str "refs/remotes/" ref)]
    :else [(str "refs/heads/" ref)]))

(defn git-ref-exists? [repo ref]
  (boolean
    (some #(zero? (:exit (p/shell {:dir repo :continue true :out :string :err :string}
                                  "git" "show-ref" "--verify" "--quiet" %)))
          (git-ref-candidates ref))))
(defn base-ref [ctx base]
  (let [repo (repo-dir ctx)
        remote-ref (str "origin/" base)]
    (cond
      (git-ref-exists? repo remote-ref) remote-ref
      (git-ref-exists? repo base) base
      :else remote-ref)))

(defn git-user-config [ctx]
  (get-in ctx [:run :git-user]))

(defn git-user-args [ctx]
  (let [user (not-empty (git-user-config ctx))]
    (if-not (and (map? user) (:name user) (:email user))
      []
      ["-c" (str "user.name=" (:name user))
       "-c" (str "user.email=" (:email user))])))

(defn git-ensure-branch! [_wf ctx _state-id node]
  (let [branch (branch-name ctx node)
        base (or (get-in ctx [:inputs :base-branch]) (get-in ctx [:workflow :defaults :base-branch]) "main")
        repo (repo-dir ctx node)
        ua (git-user-args ctx)]
    (apply shell! {:dir repo} "git" (concat ua ["fetch" "origin"]))
    (let [exists? (git-ref-exists? repo branch)
          start-point (base-ref (assoc-in ctx [:inputs :repo-root] repo) base)]
      (if exists?
        (apply shell! {:dir repo} "git" (concat ua ["checkout" branch]))
        (apply shell! {:dir repo} "git" (concat ua ["checkout" "-b" branch start-point])))
      {:status "ok" :branch branch :base-branch base :start-point start-point})))

(defn safe-path-component [s]
  (let [component (-> (str s)
                      (str/replace #"[^A-Za-z0-9._-]+" "-")
                      (str/replace #"^-+|-+$" ""))]
    (if (str/blank? component) "branch" component)))

(defn absolute-normal-path [p]
  (str (.normalize (.toAbsolutePath (java.nio.file.Paths/get (str p) (into-array String []))))))

(defn inside-dir? [parent child]
  (let [parent-path (.normalize (.toAbsolutePath (java.nio.file.Paths/get (str parent) (into-array String []))))
        child-path (.normalize (.toAbsolutePath (java.nio.file.Paths/get (str child) (into-array String []))))]
    (.startsWith child-path parent-path)))

(defn worktree-dir [ctx node branch]
  (let [repo (repo-dir ctx node)
        configured (get-in node [:inputs :worktree-dir])]
    (if configured
      (do
        (when-not (spec/safe-relative-path? configured)
          (throw (ex-info "Worktree dir override must be a safe relative path" {:worktree-dir configured})))
        (let [p (fs/path repo configured)]
          (when-not (inside-dir? repo p)
            (throw (ex-info "Worktree dir must stay inside the repo root" {:worktree-dir configured})))
          (absolute-normal-path p)))
      (absolute-normal-path (fs/path repo ".agent-worktrees" (str (get-in ctx [:workflow :name]) "-" (get-in ctx [:run :id]) "-" (safe-path-component branch)))))))

(defn current-worktree-branch [path]
  (str/trim (shell! {:dir path} "git" "rev-parse" "--abbrev-ref" "HEAD")))

(defn git-worktree? [path]
  (zero? (:exit (p/shell {:dir path :continue true :out :string :err :string}
                         "git" "rev-parse" "--is-inside-work-tree"))))

(defn worktree-path-for-branch [repo branch]
  (let [raw (shell! {:dir repo} "git" "worktree" "list" "--porcelain")]
    (loop [lines (str/split-lines raw) path nil]
      (when-let [line (first lines)]
        (cond
          (str/starts-with? line "worktree ")
          (recur (rest lines) (subs line (count "worktree ")))

          (= line (str "branch refs/heads/" branch))
          path

          :else
          (recur (rest lines) path))))))

(defn ensure-worktree-path! [repo branch path start-point]
  (if (fs/exists? path)
    (do
      (when-not (git-worktree? path)
        (throw (ex-info "Worktree path exists but is not a Git worktree" {:path path})))
      (let [actual (current-worktree-branch path)]
        (when-not (= branch actual)
          (throw (ex-info "Worktree path is checked out on a different branch" {:path path :expected branch :actual actual})))))
    (if (git-ref-exists? repo branch)
      (if-let [existing (worktree-path-for-branch repo branch)]
        (throw (ex-info "Branch is already checked out in another worktree" {:branch branch :existing-worktree existing :expected-worktree path}))
        (shell! {:dir repo} "git" "worktree" "add" path branch))
      (shell! {:dir repo} "git" "worktree" "add" "-b" branch path start-point))))

(defn git-ensure-worktree! [_wf ctx _state-id node]
  (let [branch (branch-name ctx node)
        _ (when (str/blank? branch) (throw (ex-info "Branch name is blank" {})))
        base (or (get-in ctx [:inputs :base-branch]) (get-in ctx [:workflow :defaults :base-branch]) "main")
        repo (repo-dir ctx node)
        path (worktree-dir ctx node branch)
        out-path (artifact-path ctx (or (get-in node [:outputs :worktree-path :path])
                                        (get-in node [:inputs :path-output])
                                        "worktree/path.txt"))
        ua (git-user-args ctx)]
    (apply shell! {:dir repo} "git" (concat ua ["fetch" "origin"]))
    (let [start-point (base-ref (assoc-in ctx [:inputs :repo-root] repo) base)]
      (fs/create-dirs (fs/parent path))
      (ensure-worktree-path! repo branch path start-point)
      ;; Apply the configured git identity to the worktree via `git config --local`
      ;; so commits made by agent nodes inside the worktree are attributed to the
      ;; configured user. Worktrees share the repo's .git/config, so this is a
      ;; local single-user workspace affordance (see docs/design). Never writes
      ;; global git config.
      (when (seq ua)
        (let [user (git-user-config ctx)]
          (shell! {:dir path} "git" "config" "--local" "user.name" (:name user))
          (shell! {:dir path} "git" "config" "--local" "user.email" (:email user))))
      (fs/create-dirs (fs/parent out-path))
      (store/write-runtime-text! ctx out-path path)
      {:status "ok" :branch branch :base-branch base :start-point start-point :worktree-dir path :worktree-file out-path})))

(defn git-push! [_wf ctx _state-id node]
  (let [branch (branch-name ctx node)
        ua (git-user-args ctx)]
    (apply shell! {:dir (repo-dir ctx node)} "git" (concat ua ["push" "origin" branch]))
    {:status "ok" :branch branch}))

(defn mock-worktree-dir [ctx node]
  (or (artifact-text ctx (get-in node [:inputs :repo-dir-file]))
      (str (fs/path (get-in ctx [:run :dir]) "mock-worktree"))))

(defn mock-git-ensure-branch! [_wf ctx _state-id node]
  {:status "ok" :mock true :branch (branch-name ctx node)
   :base-branch (or (get-in ctx [:inputs :base-branch]) (get-in ctx [:workflow :defaults :base-branch]) "main")})

(defn mock-git-ensure-worktree! [_wf ctx _state-id node]
  (let [branch (branch-name ctx node)
          base (or (get-in ctx [:inputs :base-branch]) (get-in ctx [:workflow :defaults :base-branch]) "main")
          path (mock-worktree-dir ctx node)
          out-path (output-path ctx node :worktree-path "worktree/path.txt")]
    (fs/create-dirs path)
    (fs/create-dirs (fs/parent out-path))
    (store/write-runtime-text! ctx out-path path)
    {:status "ok" :mock true :branch branch :base-branch base :start-point (str "origin/" base) :worktree-dir path :worktree-file out-path}))

(defn mock-git-push! [_wf ctx _state-id node]
  {:status "ok" :mock true :branch (branch-name ctx node)})
