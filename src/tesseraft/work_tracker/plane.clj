(ns tesseraft.work-tracker.plane
  (:require
    [cheshire.core :as json]
    [clojure.string :as str]
    [tesseraft.runtime.store :as store]
    [tesseraft.work-tracker.errors :as errors]
    [tesseraft.work-tracker.http :as http])
  (:import
    [java.net URLEncoder]))

(def default-timeout-ms http/default-timeout-ms)
(def max-timeout-ms http/max-timeout-ms)

(def ^:dynamic *http-request* nil)

(defn- present-string [v]
  (when (string? v)
    (not-empty (str/trim v))))

(defn- encode-segment [s]
  (-> (URLEncoder/encode (str s) "UTF-8")
      (str/replace "+" "%20")))

(defn plane-item-url [api-base-url workspace-slug project-id item-id]
  (let [base (str/replace (present-string api-base-url) #"/+$" "")
        path (str "/api/v1/workspaces/" (encode-segment workspace-slug)
                  "/projects/" (encode-segment project-id)
                  "/issues/" (encode-segment item-id) "/")]
    (str base path)))

(defn plane-remote-issue-id? [s]
  (boolean
    (when-let [id (present-string s)]
      (re-matches #"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" id))))

(defn- safe-rate-limit-metadata [headers]
  (http/rate-limit-metadata headers))

(def production-http-request http/production-request)

(defn- http-request [request]
  (http/request *http-request* request))

(defn- response-value [response k]
  (http/response-value response k))

(defn- http-status [response]
  (http/status response))

(defn- failure
  ([category message] (failure category message {}))
  ([category message details]
   (errors/failure "plane" category message details)))

(defn- bounded-timeout-ms [v]
  (http/bounded-timeout-ms v))

(defn- state-name [issue]
  (or (present-string (get-in issue [:state :name]))
      (present-string (get-in issue [:state_detail :name]))
      (present-string (:state issue))))

(defn- normalize-priority [p]
  (let [s (some-> p str str/lower-case str/trim)]
    (if (contains? #{"urgent" "high" "medium" "low" "none"} s) s "none")))

(defn- non-empty-coll [v]
  (when (and (coll? v) (seq v)) v))

(defn- normalize-assignee [a]
  (cond
    (string? a)
    (when-let [id (present-string a)] {:id id})

    (map? a)
    (when-let [id (or (present-string (:id a)) (present-string (:pk a)) (present-string (:member_id a)))]
      (cond-> {:id id}
        (present-string (:display_name a)) (assoc :display_name (present-string (:display_name a)))
        (present-string (:first_name a)) (assoc :display_name (str/trim (str (:first_name a) " " (:last_name a))))
        (present-string (:email a)) (assoc :email (present-string (:email a)))))))

(defn- normalize-label [l]
  (cond
    (string? l)
    (when-let [id (present-string l)] {:id id})

    (map? l)
    (let [id (present-string (:id l))
          name (present-string (:name l))]
      (when (or id name)
        (cond-> {}
          id (assoc :id id)
          name (assoc :name name)
          (present-string (:color l)) (assoc :color (present-string (:color l))))))))

(defn- plane-project-prefix [tracker issue]
  (or (present-string (get-in issue [:project_detail :identifier]))
      (present-string (get-in issue [:project :identifier]))
      (present-string (:project_identifier issue))
      (present-string (get-in tracker [:config :project-identifier]))
      (present-string (get-in tracker [:config :project-key]))))

(defn- sequence-identifier [tracker issue]
  (let [sequence (:sequence_id issue)
        sequence-text (cond
                        (number? sequence) (str sequence)
                        (string? sequence) (present-string sequence))]
    (when sequence-text
      (if-let [prefix (plane-project-prefix tracker issue)]
        (str prefix "-" sequence-text)
        sequence-text))))

(defn normalize-plane-issue [tracker tesseraft-project-id item-id issue]
  (let [identifier (or (present-string (:identifier issue))
                       (sequence-identifier tracker issue)
                       (str item-id))]
    {:schema_version 1
     :provider "plane"
     :project {:id (str tesseraft-project-id)}
     :remote {:id (or (present-string (:id issue)) (str item-id))
              :identifier identifier
              :workspace_slug (get-in tracker [:config :workspace-slug])
              :project_id (get-in tracker [:config :project-id])}
     :identifier identifier
     :title (or (present-string (:name issue)) (present-string (:title issue)) "")
     :description (or (present-string (:description_stripped issue))
                      (present-string (:description_html issue))
                      (present-string (:description issue))
                      "")
     :state {:name (or (state-name issue) "unknown")}
     :priority (normalize-priority (:priority issue))
     :assignees (into [] (keep normalize-assignee) (or (non-empty-coll (:assignee_details issue))
                                                       (non-empty-coll (:assignees issue))
                                                       []))
     :labels (into [] (keep normalize-label) (or (non-empty-coll (:label_details issue))
                                                 (non-empty-coll (:labels issue))
                                                 []))
     :url (or (present-string (:url issue)) (present-string (:html_url issue)))
     :fetched_at (store/now)}))

(defn fetch-item [{:keys [tracker api-key item-id timeout-ms tesseraft-project-id]}]
  (let [{:keys [api-base-url workspace-slug project-id]} (:config tracker)
        request-timeout-ms (bounded-timeout-ms timeout-ms)]
    (cond
      (not (every? present-string [api-base-url workspace-slug project-id item-id api-key]))
      (failure "invalid_request" "Plane fetch requires api-base-url, workspace-slug, project-id, Plane remote issue ID, and API key")

      (not request-timeout-ms)
      (failure "invalid_timeout" (str "Plane timeout-ms must be a positive duration; values above " max-timeout-ms "ms are clamped"))

      (not (plane-remote-issue-id? item-id))
      (failure "invalid_item_id" "Plane fetch supports only documented Plane remote issue IDs; human identifiers require an explicit resolver")

      :else
      (let [url (plane-item-url api-base-url workspace-slug project-id item-id)
            response (http-request {:method "GET"
                                    :url url
                                    :headers {"X-API-Key" api-key "Accept" "application/json"}
                                    :timeout-ms request-timeout-ms})]
        (let [status (http-status response)
              body (response-value response :body)
              headers (response-value response :headers)
              error (response-value response :error)]
          (cond
            (= :timeout error) (failure "timeout" "Plane request timed out")
            error (failure "transport" "Plane transport failed")
            (= 200 status)
            (try
              {:ok true :status "ok" :item (normalize-plane-issue tracker tesseraft-project-id item-id (json/parse-string (or body "") true))}
              (catch Throwable _
                (failure "malformed_json" "Plane returned malformed JSON" {:http_status 200})))
            (= 429 status)
            (failure "rate_limited" "Plane rate limit exceeded"
                     {:http_status 429 :rate_limit (safe-rate-limit-metadata headers)})
            (= 401 status) (failure "unauthorized" "Plane credential was rejected" {:http_status 401})
            (= 404 status) (failure "not_found" "Plane item was not found" {:http_status 404})
            (nil? status) (failure "malformed_output" "Plane transport returned malformed response metadata")
            (<= 400 status 499) (failure "client_error" "Plane request failed" {:http_status status})
            (<= 500 status 599) (failure "server_error" "Plane service failed" {:http_status status})
            :else (failure "unexpected_status" "Plane returned an unexpected status" {:http_status status})))))))
