(ns tesseraft.runtime.sessions-test
  (:require
    [clojure.test :refer [deftest is testing]]
    [tesseraft.runtime.sessions :as sessions]))

(def base-ctx
  {:run {:id "run-1"
         :dir "/tmp/tesseraft-session-unit"
         :attempt 3
         :executor-mode "mock"}
   :inputs {:repo-root "."}})

(def base-node
  {:type :agent
   :executor :pi-cli
   :prompt-template "prompts/initial.md.tmpl"
   :session {:mode :resumable
             :continuation-prompt-template "prompts/continuation.md.tmpl"}
   :tools [:read :bash]
   :runtime {:cwd "."}})

(defn binding-for [ctx state-id node]
  {:version 1
   :run_id (get-in ctx [:run :id])
   :state (sessions/state-string state-id)
   :executor (sessions/effective-executor ctx node)
   :status "suspended"
   :session_ref {:kind "id" :value "session-1"}
   :configuration_hash (sessions/configuration-hash ctx state-id node)
   :activation_sequence 1
   :last_activation {:attempt 1}})

(deftest session-identity-preserves-the-complete-state-id
  (is (= "team-a/implement" (sessions/state-string :team-a/implement)))
  (is (not= (sessions/encoded-state-id :team-a/implement)
            (sessions/encoded-state-id :team-b/implement))))

(deftest configuration-hash-treats-tools-as-a-capability-set
  (is (= (sessions/configuration-hash base-ctx :implement base-node)
         (sessions/configuration-hash base-ctx :implement
                                      (assoc base-node :tools [:bash :read]))))
  (is (not= (sessions/configuration-hash base-ctx :implement base-node)
            (sessions/configuration-hash base-ctx :implement
                                         (assoc base-node :model "different")))))

(deftest activation-plan-starts-once-and-resumes-only-a-suspended-binding
  (let [started (sessions/activation-plan base-ctx :implement base-node nil)
        binding (binding-for base-ctx :implement base-node)
        resumed (sessions/activation-plan base-ctx :implement base-node binding)]
    (is (= :start (:operation started)))
    (is (= 1 (:activation-sequence started)))
    (is (= :resume (:operation resumed)))
    (is (= 2 (:activation-sequence resumed)))
    (is (= (:session_ref binding) (:session-ref resumed)))
    (testing "active and configuration-drifted bindings fail closed"
      (is (thrown-with-msg? clojure.lang.ExceptionInfo
                            #"not at a safe suspended boundary"
                            (sessions/activation-plan base-ctx :implement base-node
                                                      (assoc binding :status "active"))))
      (is (thrown-with-msg? clojure.lang.ExceptionInfo
                            #"configuration changed"
                            (sessions/activation-plan base-ctx :implement
                                                      (assoc base-node :model "different")
                                                      binding))))))

(deftest executor-emitted-session-reference-is-late-bound-only-on-start
  (let [started (sessions/activation-plan base-ctx :implement base-node nil
                                          :executor-emitted)
        binding (binding-for base-ctx :implement base-node)
        resumed (sessions/activation-plan base-ctx :implement base-node binding
                                          :executor-emitted)]
    (is (= :start (:operation started)))
    (is (not (contains? started :session-ref)))
    (is (= :resume (:operation resumed)))
    (is (= (:session_ref binding) (:session-ref resumed)))))
