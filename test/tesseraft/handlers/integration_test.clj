(ns tesseraft.handlers.integration-test
  (:require
    [babashka.fs :as fs]
    [babashka.process :as process]
    [cheshire.core :as json]
    [clojure.test :refer [deftest is]]
    [tesseraft.adapters.builtin :as builtin]
    [tesseraft.runtime.store :as store]
    [tesseraft.test-support.connections-doctor :as doctor-fixture]))

(defn- temp-dir [prefix]
  (str (java.nio.file.Files/createTempDirectory
         prefix
         (make-array java.nio.file.attribute.FileAttribute 0))))

(deftest prepared-web-build-serves-multiple-projects-and-stops-cleanly
  (let [cwd (str (fs/absolutize "."))
        server-entry (fs/path cwd "web" "dist-server" "server.js")
        run-dir (temp-dir "doctor-live-server")
        fixture-root (temp-dir "doctor-live-fixture")
        ctx {:inputs {:repo-root cwd}
             :run {:dir run-dir :worktree-dir cwd :round 1}}
        node {:runtime {:cwd cwd}
              :inputs {:host "127.0.0.1"
                       :port 0
                       :build-command nil
                       :command ["node" (str server-entry) "--host" "127.0.0.1" "--port" "0"]}
              :outputs {:test-server {:path "manual-testing/test-server-1.json"}}}
        stop-node {:inputs {:server-file "manual-testing/test-server-1.json"}}]
    (is (fs/exists? server-entry)
        "test:integration requires a prepared Web build; run npm run build:web first")
    (try
      (let [_fixture (doctor-fixture/seed-project! fixture-root)
            server-node (assoc-in node [:inputs :env]
                                  {"TESSERAFT_HOME" (get _fixture "tesseraft_home")})
            started (builtin/start-test-server! nil ctx :start-test-server server-node)
            artifact (store/read-json (:test-server-file started))
            response (process/shell {:out :string :err :string}
                                    "curl" "-fsS" (str (:url artifact) "/api/projects"))
            projects (json/parse-string (:out response) true)
            ids (set (map :project_id (:projects projects)))
            stopped (builtin/stop-test-server! nil ctx :stop-test-server stop-node)]
        (is (contains? ids "default"))
        (is (contains? ids "doctor-explicit"))
        (is (= true (:process-found stopped)))
        (is (= true (:stop-requested stopped)))
        (is (= true (:stopped stopped))))
      (finally
        (fs/delete-tree fixture-root)
        (fs/delete-tree run-dir)))))
