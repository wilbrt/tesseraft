(ns tesseraft.identity.git
  (:require
    [babashka.fs :as fs]
    [clojure.string :as str]
    [tesseraft.persistence.safe-write :as safe-write]
    [tesseraft.project.descriptor :as descriptor]
    [tesseraft.runtime.store :as store]))

(def version 1)

(defn path [tesseraft-home]
  (fs/path tesseraft-home "git-identities.json"))

(defn validate-identity [identity]
  (cond
    (not (map? identity)) "Git identity must be an object"
    (seq (remove #{:name :email} (keys identity))) "Git identity contains unknown fields"
    (not (and (string? (:name identity)) (not (str/blank? (:name identity))))) "Git identity name is required"
    (str/includes? (:name identity) "\n") "Git identity name must not contain newlines"
    (not (and (string? (:email identity))
              (re-matches #"^[^@\s]+@[^@\s]+\.[^@\s]+$" (:email identity)))) "Git identity email is invalid"
    :else nil))

(defn validate [data]
  (cond
    (not (map? data)) "Git identity store must be an object"
    (not= version (:version data)) "unsupported Git identity store version"
    (seq (remove #{:version :default :projects} (keys data))) "Git identity store contains unknown fields"
    (and (:default data) (validate-identity (:default data))) (validate-identity (:default data))
    (not (map? (:projects data))) "Git identity projects must be an object"
    :else
    (some (fn [[project-id identity]]
            (or (when-not (descriptor/valid-project-id? (name project-id)) "Git identity project id is invalid")
                (validate-identity identity)))
          (:projects data))))

(defn read! [tesseraft-home]
  (let [identity-path (path tesseraft-home)]
    (if-not (fs/exists? identity-path)
      {:version version :projects {}}
      (let [data (store/read-json identity-path)]
        (if-let [error (validate data)]
          (throw (ex-info error {:code :invalid-git-identities :path (str identity-path)}))
          data)))))

(defn write! [tesseraft-home data]
  (if-let [error (validate data)]
    (throw (ex-info error {:code :invalid-git-identities :path (str (path tesseraft-home))}))
    (safe-write/write-json! (path tesseraft-home) data {:owner-only? true})))

(defn resolve-identity [data project-id]
  (if-let [identity (and project-id (get-in data [:projects (keyword project-id)]))]
    (assoc identity :source "project-override")
    (if-let [identity (:default data)]
      (assoc identity :source "user-default")
      {:name nil :email nil :source "none"})))

(defn put-identity [data project-id identity]
  (if project-id
    (assoc-in data [:projects (keyword project-id)] identity)
    (assoc data :default identity)))
