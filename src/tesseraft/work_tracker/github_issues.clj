(ns tesseraft.work-tracker.github-issues
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

(defn- safe-rate-limit-metadata [headers]
  (let [remaining (header-value headers "X-RateLimit-Remaining")
        reset (header-value headers "X-RateLimit-Reset")
        retry (header-value headers "Retry-After")]
    (cond-> {}
      remaining (assoc :remaining remaining)
      reset (assoc :reset reset)
      retry (assoc :retry_after retry))))

(defn- failure
  ([category message] (failure category message {}))
  ([category message details]
   (merge {:ok false :status "error" :provider "github-issues" :category category :message message} details)))

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

(defn- repository? [s]
  (boolean (when-let [r (present-string s)] (re-matches #"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" r))))

(defn- issue-number? [s]
  (boolean (when-let [n (present-string s)] (re-matches #"[1-9][0-9]*" n))))

(defn github-issue-url [repository number]
  (let [[owner repo] (str/split repository #"/" 2)]
    (str "https://api.github.com/repos/" (encode-segment owner) "/" (encode-segment repo) "/issues/" (encode-segment number))))

(defn- normalize-priority [issue]
  (let [names (set (map #(some-> (:name %) str str/lower-case str/trim) (:labels issue)))]
    (or (first (filter names ["urgent" "high" "medium" "low"])) "none")))

(defn- normalize-assignee [a]
  (when (map? a)
    (when-let [id (or (some-> (:id a) str present-string) (present-string (:login a)))]
      (cond-> {:id id}
        (present-string (:login a)) (assoc :display_name (present-string (:login a)))))))

(defn- normalize-label [l]
  (when (map? l)
    (let [id (some-> (:id l) str present-string)
          name (present-string (:name l))]
      (when (or id name)
        (cond-> {}
          id (assoc :id id)
          name (assoc :name name)
          (present-string (:color l)) (assoc :color (present-string (:color l))))))))

(defn normalize-github-issue [tracker tesseraft-project-id item-id issue]
  (let [number (or (some-> (:number issue) str present-string) (str item-id))]
    {:schema_version 1
     :provider "github-issues"
     :project {:id (str tesseraft-project-id)}
     :remote {:id (or (some-> (:id issue) str present-string) number)
              :identifier (str "#" number)
              :repository (get-in tracker [:config :repository])}
     :identifier (str "#" number)
     :title (or (present-string (:title issue)) "")
     :description (or (present-string (:body issue)) "")
     :state {:name (or (present-string (:state issue)) "unknown")}
     :priority (normalize-priority issue)
     :assignees (into [] (keep normalize-assignee) (or (:assignees issue) []))
     :labels (into [] (keep normalize-label) (or (:labels issue) []))
     :url (or (present-string (:html_url issue))
              (str "https://github.com/" (get-in tracker [:config :repository]) "/issues/" number))
     :fetched_at (store/now)}))

(defn fetch-item [{:keys [tracker token item-id timeout-ms tesseraft-project-id]}]
  (let [repository (get-in tracker [:config :repository])
        request-timeout-ms (bounded-timeout-ms timeout-ms)]
    (cond
      (not (every? present-string [repository item-id token]))
      (failure "invalid_request" "GitHub Issues fetch requires repository, numeric issue number, and credential")

      (not (repository? repository))
      (failure "invalid_config" "GitHub Issues repository must be owner/name")

      (not request-timeout-ms)
      (failure "invalid_timeout" (str "GitHub Issues timeout-ms must be a positive duration; values above " max-timeout-ms "ms are clamped"))

      (not (issue-number? item-id))
      (failure "invalid_item_id" "GitHub Issues item-id must be a numeric issue number")

      :else
      (let [response (http-request {:method "GET"
                                    :url (github-issue-url repository item-id)
                                    :headers {"Authorization" (str "Bearer " token)
                                              "Accept" "application/vnd.github+json"
                                              "X-GitHub-Api-Version" "2022-11-28"}
                                    :timeout-ms request-timeout-ms})
            status (http-status response)
            body (response-value response :body)
            headers (response-value response :headers)
            error (response-value response :error)]
        (cond
          (= :timeout error) (failure "timeout" "GitHub Issues request timed out")
          error (failure "transport" "GitHub Issues transport failed")
          (= 200 status)
          (try
            (let [issue (json/parse-string (or body "") true)]
              (cond
                (not (and (map? issue) (:number issue)))
                (failure "malformed_output" "GitHub returned malformed issue output" {:http_status 200})
                (contains? issue :pull_request)
                (failure "not_issue" "GitHub Issues endpoint returned a pull request, not an issue" {:http_status 200})
                :else
                {:ok true :status "ok" :item (normalize-github-issue tracker tesseraft-project-id item-id issue)}))
            (catch Throwable _ (failure "malformed_json" "GitHub returned malformed JSON" {:http_status 200})))
          (= 429 status) (failure "rate_limited" "GitHub Issues rate limit exceeded" {:http_status 429 :rate_limit (safe-rate-limit-metadata headers)})
          (= 401 status) (failure "unauthorized" "GitHub Issues credential was rejected" {:http_status 401})
          (and (= 403 status) (= "0" (header-value headers "X-RateLimit-Remaining")))
          (failure "rate_limited" "GitHub Issues rate limit exceeded" {:http_status 403 :rate_limit (safe-rate-limit-metadata headers)})
          (= 403 status) (failure "forbidden" "GitHub Issues credential is not allowed to read the issue" {:http_status 403})
          (= 404 status) (failure "not_found" "GitHub issue was not found" {:http_status 404})
          (nil? status) (failure "malformed_output" "GitHub Issues transport returned malformed response metadata")
          (<= 400 status 499) (failure "client_error" "GitHub Issues request failed" {:http_status status})
          (<= 500 status 599) (failure "server_error" "GitHub service failed" {:http_status status})
          :else (failure "unexpected_status" "GitHub returned an unexpected status" {:http_status status}))))))
