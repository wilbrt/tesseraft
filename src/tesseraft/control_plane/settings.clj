(ns tesseraft.control-plane.settings
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [tesseraft.identity.git :as git-identity]
            [tesseraft.preferences.store :as preferences]))

(defn- home [options]
  (or (:tesseraft-home options) (System/getenv "TESSERAFT_HOME")
      (str (fs/path (System/getProperty "user.home") ".tesseraft"))))
(defn- error [status code message & [details]]
  {:status status :error {:code code :message message :details (or details {})}})
(defn validate-git-user [name email]
  (cond
    (not (string? name)) "name must be a string"
    (str/blank? (str/trim name)) "name must not be empty"
    (> (count name) 200) "name must be at most 200 characters"
    (re-find #"\n" name) "name must not contain newlines"
    (not (string? email)) "email must be a string"
    (str/blank? (str/trim email)) "email must not be empty"
    (re-find #"[\s]" email) "email must not contain whitespace"
    (not (re-matches #"^[^@]+@[^@]+\.[^@]+$" email)) "email is not a valid address"
    :else nil))
(defn get-git-user [options project-id]
  (try {:git_user (git-identity/resolve-identity (git-identity/read! (home options)) project-id)}
       (catch clojure.lang.ExceptionInfo e (error 400 "invalid_git_identity_store" (.getMessage e) {:path (:path (ex-data e))}))))
(defn set-git-user [options name email global? project-id]
  (if-let [problem (validate-git-user name email)] (error 400 "bad_request" problem)
    (try
      (let [root (home options) data (git-identity/read! root) override-id (when-not global? project-id)]
        (when (and (not global?) (nil? override-id)) (throw (ex-info "A project id is required for a project Git identity override" {:code :missing-project-id})))
        (git-identity/write! root (git-identity/put-identity data override-id {:name name :email email}))
        (get-git-user options project-id))
      (catch clojure.lang.ExceptionInfo e (error 400 "invalid_git_identity_store" (.getMessage e) {:path (:path (ex-data e))})))))
(defn get-settings [options]
  (try (let [values (:preferences (preferences/read! (home options)))]
         {:settings (assoc values :color_scheme (or (:color_scheme values) "classic") :source "user-preferences")})
       (catch clojure.lang.ExceptionInfo e (error 400 "invalid_preferences" (.getMessage e) {:path (:path (ex-data e))}))))
(defn set-settings [options updates]
  (if (empty? updates) (get-settings options)
    (let [unknown (remove preferences/fields (keys updates))]
      (cond
        (seq unknown) (error 400 "bad_request" (str "Unknown settings fields: " (str/join ", " (map name (sort unknown)))))
        :else (let [problems (keep (fn [[k v]] (preferences/validate-value k v)) updates)]
                (if (seq problems) (error 400 "bad_request" (str/join "; " problems))
                  (let [root (home options) current (preferences/read! root)
                        merged (:preferences (preferences/update-values current updates))]
                    (if (and (contains? merged :pi_default_model) (not (contains? merged :pi_default_provider)))
                      (error 400 "bad_request" "pi_default_provider is required when pi_default_model is set")
                      (do (preferences/write! root (assoc current :preferences merged)) (get-settings options))))))))))
