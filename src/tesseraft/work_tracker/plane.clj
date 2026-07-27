(ns tesseraft.work-tracker.plane
  (:require
    [cheshire.core :as json]
    [clojure.string :as str]
    [tesseraft.runtime.store :as store])
  (:import
    [java.net URI URLEncoder]
    [java.net.http HttpClient HttpRequest HttpRequest$BodyPublishers HttpResponse HttpResponse$BodyHandlers HttpTimeoutException]
    [java.time Duration]))

(def default-timeout-ms 5000)

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

(defn- response-headers-map [headers]
  (cond
    (map? headers) headers
    headers (into {} (for [[k vs] (.map headers)] [(str k) (first vs)]))
    :else {}))

(defn- header-value [headers name]
  (some (fn [[k v]] (when (= (str/lower-case (str k)) (str/lower-case name)) (str v))) headers))

(defn- safe-rate-limit-metadata [headers]
  (let [remaining (header-value headers "X-RateLimit-Remaining")
        reset (header-value headers "X-RateLimit-Reset")]
    (cond-> {}
      remaining (assoc :remaining remaining)
      reset (assoc :reset reset))))

(defn production-http-request [{:keys [method url headers timeout-ms]}]
  (try
    (let [timeout (Duration/ofMillis (long (or timeout-ms default-timeout-ms)))
          client (-> (HttpClient/newBuilder)
                     (.connectTimeout timeout)
                     (.build))
          builder (-> (HttpRequest/newBuilder (URI/create url))
                      (.timeout timeout)
                      (.method (or method "GET") (HttpRequest$BodyPublishers/noBody)))]
      (doseq [[k v] headers]
        (.header builder (str k) (str v)))
      (let [response (.send client (.build builder) (HttpResponse$BodyHandlers/ofString))]
        {:status (.statusCode response)
         :headers (response-headers-map (.headers response))
         :body (.body response)}))
    (catch HttpTimeoutException _
      {:error :timeout})
    (catch Throwable t
      {:error :transport :message (or (.getMessage t) "transport error")})))

(defn- http-request [request]
  ((or *http-request* production-http-request) request))

(defn- response-value [response k]
  (or (get response k)
      (get response (name k))))

(defn- failure
  ([category message] (failure category message {}))
  ([category message details]
   (merge {:ok false
           :status "error"
           :provider "plane"
           :category category
           :message message}
          details)))

(defn- state-name [issue]
  (or (present-string (get-in issue [:state :name]))
      (present-string (get-in issue [:state_detail :name]))
      (present-string (:state issue))))

(defn- normalize-priority [p]
  (let [s (some-> p str str/lower-case str/trim)]
    (if (contains? #{"urgent" "high" "medium" "low" "none"} s) s "none")))

(defn- normalize-assignee [a]
  (cond-> {:id (or (present-string (:id a)) (present-string (:pk a)) (present-string (:member_id a)) "")}
    (present-string (:display_name a)) (assoc :display_name (present-string (:display_name a)))
    (present-string (:first_name a)) (assoc :display_name (str/trim (str (:first_name a) " " (:last_name a))))
    (present-string (:email a)) (assoc :email (present-string (:email a)))))

(defn- normalize-label [l]
  (cond
    (string? l) {:name l}
    (map? l) (cond-> {:name (or (present-string (:name l)) (present-string (:id l)) "")}
               (present-string (:color l)) (assoc :color (present-string (:color l))))
    :else {:name (str l)}))

(defn normalize-plane-issue [tracker item-id issue]
  {:schema_version 1
   :provider "plane"
   :project {:id (get-in tracker [:config :project-id])
             :workspace_slug (get-in tracker [:config :workspace-slug])}
   :remote {:id (or (present-string (:id issue)) (str item-id))
            :identifier (or (present-string (:identifier issue))
                            (present-string (:sequence_id issue))
                            (str item-id))}
   :identifier (or (present-string (:identifier issue))
                   (present-string (:sequence_id issue))
                   (str item-id))
   :title (or (present-string (:name issue)) (present-string (:title issue)) "")
   :description (or (present-string (:description_stripped issue))
                    (present-string (:description_html issue))
                    (present-string (:description issue))
                    "")
   :state {:name (or (state-name issue) "unknown")}
   :priority (normalize-priority (:priority issue))
   :assignees (mapv normalize-assignee (or (:assignees issue) (:assignee_details issue) []))
   :labels (mapv normalize-label (or (:labels issue) (:label_details issue) []))
   :url (or (present-string (:url issue)) (present-string (:html_url issue)))
   :fetched_at (store/now)})

(defn fetch-item [{:keys [tracker api-key item-id timeout-ms]}]
  (let [{:keys [api-base-url workspace-slug project-id]} (:config tracker)]
    (cond
      (not (every? present-string [api-base-url workspace-slug project-id item-id api-key]))
      (failure "invalid_request" "Plane fetch requires api-base-url, workspace-slug, project-id, Plane remote issue ID, and API key")

      (not (plane-remote-issue-id? item-id))
      (failure "invalid_item_id" "Plane fetch supports only remote issue IDs; human identifiers require an explicit resolver")

      :else
      (let [url (plane-item-url api-base-url workspace-slug project-id item-id)
            response (http-request {:method "GET"
                                    :url url
                                    :headers {"X-API-Key" api-key "Accept" "application/json"}
                                    :timeout-ms (or timeout-ms default-timeout-ms)})]
        (let [status (response-value response :status)
              body (response-value response :body)
              headers (response-value response :headers)
              error (response-value response :error)]
          (cond
            (= :timeout error) (failure "timeout" "Plane request timed out")
            error (failure "transport" "Plane transport failed")
            (= 200 status)
            (try
              {:ok true :status "ok" :item (normalize-plane-issue tracker item-id (json/parse-string (or body "") true))}
              (catch Throwable _
                (failure "malformed_json" "Plane returned malformed JSON" {:http_status 200})))
            (= 429 status)
            (failure "rate_limited" "Plane rate limit exceeded"
                     {:http_status 429 :rate_limit (safe-rate-limit-metadata headers)})
            (= 401 status) (failure "unauthorized" "Plane credential was rejected" {:http_status 401})
            (= 404 status) (failure "not_found" "Plane item was not found" {:http_status 404})
            (<= 400 status 499) (failure "client_error" "Plane request failed" {:http_status status})
            (<= 500 status 599) (failure "server_error" "Plane service failed" {:http_status status})
            :else (failure "unexpected_status" "Plane returned an unexpected status" {:http_status status})))))))
