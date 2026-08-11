(ns tesseraft.work-tracker.http
  (:require [clojure.string :as str])
  (:import
    [java.net URI]
    [java.net.http HttpClient HttpRequest HttpRequest$BodyPublishers HttpResponse$BodyHandlers HttpTimeoutException]
    [java.time Duration]))

(def default-timeout-ms 5000)
(def max-timeout-ms 10000)

(defn response-headers-map [headers]
  (cond
    (map? headers) headers
    headers (into {} (for [[key values] (.map headers)] [(str key) (first values)]))
    :else {}))

(defn production-request [{:keys [method url headers timeout-ms]}]
  (let [timeout (Duration/ofMillis (long (or timeout-ms default-timeout-ms)))
        client (-> (HttpClient/newBuilder) (.connectTimeout timeout) (.build))
        builder (-> (HttpRequest/newBuilder (URI/create url))
                    (.timeout timeout)
                    (.method (or method "GET") (HttpRequest$BodyPublishers/noBody)))]
    (doseq [[key value] headers] (.header builder (str key) (str value)))
    (let [response (.send client (.build builder) (HttpResponse$BodyHandlers/ofString))]
      {:status (.statusCode response)
       :headers (response-headers-map (.headers response))
       :body (.body response)})))

(defn request [transport request]
  (try
    ((or transport production-request) request)
    (catch HttpTimeoutException _ {:error :timeout})
    (catch Throwable _ {:error :transport})))

(defn response-value [response key]
  (or (get response key) (get response (name key))))

(defn status [response]
  (let [value (response-value response :status)]
    (when (integer? value) value)))

(defn bounded-timeout-ms [value]
  (try
    (let [parsed (cond
                   (nil? value) default-timeout-ms
                   (number? value) value
                   (and (string? value) (re-matches #"\d+" (str/trim value))) (Long/parseLong (str/trim value))
                   :else nil)]
      (when (and parsed (pos? parsed)) (min max-timeout-ms (long parsed))))
    (catch Throwable _ nil)))

(defn header-value [headers header-name]
  (some (fn [[key value]]
          (when (= (str/lower-case (str key)) (str/lower-case header-name)) (str value)))
        headers))

(defn- safe-token [value max-len]
  (when-let [text (some-> value str str/trim not-empty)]
    (when (and (<= (count text) max-len) (not (re-find #"[\r\n]" text))) text)))

(defn- bounded-int-string [value max-value]
  (when-let [text (safe-token value 20)]
    (when (re-matches #"[0-9]+" text)
      (try (when (<= (Long/parseLong text) max-value) text) (catch Throwable _ nil)))))

(defn rate-limit-metadata [headers]
  (let [remaining (bounded-int-string (header-value headers "X-RateLimit-Remaining") 1000000000)
        reset (bounded-int-string (header-value headers "X-RateLimit-Reset") 4102444800)
        retry (or (bounded-int-string (header-value headers "Retry-After") 86400)
                  (when-let [text (safe-token (header-value headers "Retry-After") 64)]
                    (when (re-matches #"(?i)[a-z]{3}, \d{2} [a-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT" text) text)))]
    (cond-> {}
      remaining (assoc :remaining remaining)
      reset (assoc :reset reset)
      retry (assoc :retry_after retry))))
