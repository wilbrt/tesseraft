(ns tesseraft.work-tracker.jira
  (:require
    [cheshire.core :as json]
    [clojure.string :as str]
    [tesseraft.runtime.store :as store]
    [tesseraft.work-tracker.plane :as plane])
  (:import
    [java.net URI URLEncoder]
    [java.net.http HttpClient HttpRequest HttpRequest$BodyPublishers HttpResponse HttpResponse$BodyHandlers HttpTimeoutException]
    [java.time Duration]))

(def ^:dynamic *http-request* nil)

(def default-timeout-ms plane/default-timeout-ms)
(def max-timeout-ms plane/max-timeout-ms)

(defn- present-string [v]
  (when (string? v) (not-empty (str/trim v))))

(defn- encode-segment [s]
  (-> (URLEncoder/encode (str s) "UTF-8") (str/replace "+" "%20")))

(defn- response-headers-map [headers]
  (cond
    (map? headers) headers
    headers (into {} (for [[k vs] (.map headers)] [(str k) (first vs)]))
    :else {}))

(defn production-http-request [{:keys [method url headers timeout-ms]}]
  (let [timeout (Duration/ofMillis (long (or timeout-ms default-timeout-ms)))
        client (-> (HttpClient/newBuilder) (.connectTimeout timeout) (.build))
        builder (-> (HttpRequest/newBuilder (URI/create url))
                    (.timeout timeout)
                    (.method (or method "GET") (HttpRequest$BodyPublishers/noBody)))]
    (doseq [[k v] headers] (.header builder (str k) (str v)))
    (let [response (.send client (.build builder) (HttpResponse$BodyHandlers/ofString))]
      {:status (.statusCode response)
       :headers (response-headers-map (.headers response))
       :body (.body response)})))

(defn- http-request [request]
  (try
    ((or *http-request* production-http-request) request)
    (catch HttpTimeoutException _ {:error :timeout})
    (catch Throwable _ {:error :transport})))

(defn- response-value [response k]
  (or (get response k) (get response (name k))))

(defn- http-status [response]
  (let [status (response-value response :status)]
    (when (integer? status) status)))

(defn- header-value [headers name]
  (some (fn [[k v]] (when (= (str/lower-case (str k)) (str/lower-case name)) (str v))) headers))

(defn- safe-token [v max-len]
  (when-let [s (present-string v)]
    (when (and (<= (count s) max-len) (not (re-find #"[\r\n]" s))) s)))

(defn- bounded-int-string [v max-value]
  (when-let [s (safe-token v 20)]
    (when (re-matches #"[0-9]+" s)
      (try
        (let [n (Long/parseLong s)]
          (when (<= n max-value) s))
        (catch Throwable _ nil)))))

(defn- safe-retry-token [v]
  (or (bounded-int-string v 86400)
      (when-let [s (safe-token v 64)]
        (when (re-matches #"(?i)[a-z]{3}, \d{2} [a-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT" s)
          s))))

(defn- safe-rate-limit-metadata [headers]
  (let [remaining (bounded-int-string (header-value headers "X-RateLimit-Remaining") 1000000000)
        reset (bounded-int-string (header-value headers "X-RateLimit-Reset") 4102444800)
        retry (safe-retry-token (header-value headers "Retry-After"))]
    (cond-> {}
      remaining (assoc :remaining remaining)
      reset (assoc :reset reset)
      retry (assoc :retry_after retry))))

(defn- failure
  ([category message] (failure category message {}))
  ([category message details]
   (merge {:ok false :status "error" :provider "jira" :category category :message message} details)))

(defn- parse-timeout-ms [v]
  (try
    (cond
      (nil? v) default-timeout-ms
      (number? v) v
      (and (string? v) (re-matches #"\d+" (str/trim v))) (Long/parseLong (str/trim v))
      :else nil)
    (catch Throwable _ nil)))

(defn- bounded-timeout-ms [v]
  (when-let [parsed (parse-timeout-ms v)]
    (when (pos? parsed) (min max-timeout-ms (long parsed)))))

(defn- jira-key? [project-key item-id]
  (boolean
    (when (and (present-string project-key) (present-string item-id))
      (re-matches (re-pattern (str "(?i)" (java.util.regex.Pattern/quote project-key) "-[1-9][0-9]*")) item-id))))

(defn jira-item-url [base-url item-id]
  (str (str/replace (present-string base-url) #"/+$" "")
       "/rest/api/3/issue/" (encode-segment item-id)))

(defn- normalize-priority [p]
  (let [s (some-> p str str/lower-case str/trim)]
    (if (contains? #{"urgent" "high" "medium" "low" "none"} s) s "none")))

(defn- doc-text [v]
  (cond
    (string? v) v
    (map? v) (str/join "" (keep doc-text (or (:content v) [])))
    (sequential? v) (str/join "" (keep doc-text v))
    :else nil))

(defn- normalize-assignee [a]
  (when (map? a)
    (when-let [id (or (present-string (:accountId a)) (present-string (:account_id a)) (present-string (:name a)))]
      (cond-> {:id id}
        (present-string (:displayName a)) (assoc :display_name (present-string (:displayName a)))
        (present-string (:display_name a)) (assoc :display_name (present-string (:display_name a)))))))

(defn- normalize-label [l]
  (when (string? l)
    (when-let [name (present-string l)]
      {:name name})))

(defn- valid-jira-issue? [project-key item-id issue]
  (let [fields (:fields issue)
        key (present-string (:key issue))]
    (and (map? issue)
         key
         (= (str/upper-case key) (str/upper-case (str item-id)))
         (jira-key? project-key key)
         (present-string (:id issue))
         (map? fields)
         (or (nil? (:summary fields)) (string? (:summary fields)))
         (or (nil? (:description fields)) (or (string? (:description fields)) (map? (:description fields))))
         (or (nil? (:labels fields)) (sequential? (:labels fields)))
         (every? string? (or (:labels fields) []))
         (or (nil? (:assignees fields)) (sequential? (:assignees fields)))
         (every? map? (or (:assignees fields) []))
         (or (nil? (:assignee fields)) (map? (:assignee fields))))))

(defn normalize-jira-issue [tracker tesseraft-project-id item-id issue]
  (let [fields (:fields issue)
        identifier (present-string (:key issue))]
    {:schema_version 1
     :provider "jira"
     :project {:id (str tesseraft-project-id)}
     :remote {:id (or (present-string (:id issue)) identifier)
              :identifier identifier
              :project_key (get-in tracker [:config :project-key])}
     :identifier identifier
     :title (or (present-string (:summary fields)) "")
     :description (or (present-string (doc-text (:description fields))) "")
     :state {:name (or (present-string (get-in fields [:status :name])) "unknown")}
     :priority (normalize-priority (or (get-in fields [:priority :name]) (:priority fields)))
     :assignees (into [] (keep normalize-assignee) (or (:assignees fields) (when-let [a (:assignee fields)] [a]) []))
     :labels (into [] (keep normalize-label) (or (:labels fields) []))
     :url (str (str/replace (get-in tracker [:config :base-url]) #"/+$" "") "/browse/" identifier)
     :fetched_at (store/now)}))

(defn fetch-item [{:keys [tracker token item-id timeout-ms tesseraft-project-id]}]
  (let [{:keys [base-url project-key]} (:config tracker)
        request-timeout-ms (bounded-timeout-ms timeout-ms)]
    (cond
      (not (every? present-string [base-url project-key item-id token]))
      (failure "invalid_request" "Jira fetch requires base-url, project-key, Jira issue key, and credential")

      (not request-timeout-ms)
      (failure "invalid_timeout" (str "Jira timeout-ms must be a positive duration; values above " max-timeout-ms "ms are clamped"))

      (not (jira-key? project-key item-id))
      (failure "invalid_item_id" "Jira item-id must be an issue key in the configured project")

      :else
      (let [response (http-request {:method "GET"
                                    :url (jira-item-url base-url item-id)
                                    :headers {"Authorization" (str "Bearer " token) "Accept" "application/json"}
                                    :timeout-ms request-timeout-ms})
            status (http-status response)
            body (response-value response :body)
            headers (response-value response :headers)
            error (response-value response :error)]
        (cond
          (= :timeout error) (failure "timeout" "Jira request timed out")
          error (failure "transport" "Jira transport failed")
          (= 200 status)
          (try
            (let [issue (json/parse-string (or body "") true)]
              (if (valid-jira-issue? project-key item-id issue)
                {:ok true :status "ok" :item (normalize-jira-issue tracker tesseraft-project-id item-id issue)}
                (failure "malformed_output" "Jira returned malformed issue output" {:http_status 200})))
            (catch Throwable _ (failure "malformed_json" "Jira returned malformed JSON" {:http_status 200})))
          (= 429 status) (failure "rate_limited" "Jira rate limit exceeded" {:http_status 429 :rate_limit (safe-rate-limit-metadata headers)})
          (= 401 status) (failure "unauthorized" "Jira credential was rejected" {:http_status 401})
          (= 403 status) (failure "forbidden" "Jira credential is not allowed to read the issue" {:http_status 403})
          (= 404 status) (failure "not_found" "Jira item was not found" {:http_status 404})
          (nil? status) (failure "malformed_output" "Jira transport returned malformed response metadata")
          (<= 400 status 499) (failure "client_error" "Jira request failed" {:http_status status})
          (<= 500 status 599) (failure "server_error" "Jira service failed" {:http_status status})
          :else (failure "unexpected_status" "Jira returned an unexpected status" {:http_status status}))))))
