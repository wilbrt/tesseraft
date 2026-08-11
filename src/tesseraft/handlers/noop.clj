(ns tesseraft.handlers.noop)

(defn noop-succeed! [_wf _ctx _state-id _node] {:status "ok"})
(defn mock-noop-succeed! [_wf _ctx _state-id _node] {:status "ok" :mock true})
