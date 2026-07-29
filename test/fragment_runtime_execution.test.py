#!/usr/bin/env python3
"""FI6: end-to-end runtime execution of {:type :fragment} nodes.

Each case stages a checked-in fixture from test/fixtures/valid/fragment-runtime/
into a temp project (package resolution only finds an ancestor
.tesseraft/fragments/<name>/), writes a small parent workflow around it, and
drives ./bin/tesseraft as a separate process so evidence is asserted from
durable state.edn / events.jsonl / pin.json rather than in-memory state.
"""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "test" / "fixtures" / "valid" / "fragment-runtime"


def with_tmp(fn):
    tmp = Path(tempfile.mkdtemp(prefix="tesseraft-fi6-"))
    try:
        return fn(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def tesseraft(args, home):
    env = os.environ.copy()
    env["TESSERAFT_HOME"] = str(home)
    return subprocess.run(
        [str(ROOT / "bin" / "tesseraft"), *args],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def control_plane(args, home):
    env = os.environ.copy()
    env["TESSERAFT_HOME"] = str(home)
    return subprocess.run(
        [str(ROOT / "bin" / "tesseraft"), "control-plane", *args],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def stage_fragment(tmp, name):
    src = FIXTURES / name / "fragment.edn"
    dest_dir = tmp / ".tesseraft" / "fragments" / name
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / "fragment.edn"
    shutil.copy(src, dest)
    return dest


def write_workflow(tmp, fragment_name, transitions_edn):
    workflow = f'''{{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {{:name "fragment-runtime-{fragment_name}"}}
 :initial :run-fragment
 :states
 {{:run-fragment
   {{:type :fragment
    :fragment "{fragment_name}"
    :transitions {transitions_edn}}}
  :record
  {{:type :deterministic
   :handler :noop/succeed
   :next :done}}
  :done {{:type :terminal :status :success}}
  :declared-failure {{:type :terminal :status :failure}}}}}}
'''
    path = tmp / "workflow.edn"
    path.write_text(workflow)
    return path


def read_json(path: Path):
    return json.loads(path.read_text())


def read_events(run_dir: Path):
    p = run_dir / "events.jsonl"
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


def nested_run_dir(run_dir: Path, state="run-fragment", attempt=1):
    return run_dir / "fragments" / state / str(attempt)


def start(tmp, home, wf, inputs=None, run_id=None):
    args = ["run", "start", str(wf), "--workspace-root", str(tmp), "--format", "json"]
    for k, v in (inputs or {}).items():
        args += ["--input", f"{k}={v}"]
    if run_id is not None:
        args += ["--run-id", run_id]
    proc = tesseraft(args, home)
    assert proc.returncode == 0, proc.stderr
    return Path(json.loads(proc.stdout)["run"]["dir"])


def resume(run_dir, home, max_steps=None):
    args = ["run", "resume", "--run-dir", str(run_dir), "--format", "json"]
    if max_steps is not None:
        args += ["--max-steps", str(max_steps)]
    return tesseraft(args, home)


def inspect(run_dir, home):
    proc = tesseraft(["run", "inspect", "--run-dir", str(run_dir), "--format", "json"], home)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def node_event(events, event, state="run-fragment"):
    matches = [e for e in events if e.get("event") == event and e.get("state") == state]
    assert matches, (event, state, events)
    return matches[-1]


def test_runtime_pass_fixture_takes_the_parent_success_route():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-pass")
        wf = write_workflow(tmp, "runtime-pass", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)
        proc = resume(run_dir, home)
        assert proc.returncode == 0, proc.stderr
        finished = json.loads(proc.stdout)["run"]
        assert finished["state"] == "done", finished
        assert finished["status"] == "done", finished

        events = read_events(run_dir)
        fragment_finished = node_event(events, "fragment.finished")
        assert fragment_finished["outcome"] == "pass", fragment_finished

        node_finished = node_event(events, "node.finished")
        result = node_finished["result"]
        # :fragment/outcome and plain :outcome must serialize to two distinct,
        # non-lossy JSON keys (cheshire preserves keyword namespaces in map
        # keys), not a duplicated/overwritten "outcome" key.
        assert result["fragment/outcome"] == "pass", result
        assert result["outcome"] == "pass", result

        nested_dir = nested_run_dir(run_dir)
        assert nested_dir.is_dir()
        assert (nested_dir / "state.edn").exists()
        pin = read_json(nested_dir / "pin.json")
        assert pin["fragment"] == "runtime-pass", pin
        assert pin["scope"] == "project", pin
        assert pin["package_sha256"], pin
    with_tmp(run)


def test_runtime_fail_fixture_takes_the_declared_failure_route():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-fail")
        wf = write_workflow(tmp, "runtime-fail", '[{:when {:fragment/outcome "fail"} :next :declared-failure}]')
        run_dir = start(tmp, home, wf)
        proc = resume(run_dir, home)
        assert proc.returncode == 0, proc.stderr
        finished = json.loads(proc.stdout)["run"]
        assert finished["state"] == "declared-failure", finished
        assert finished["status"] == "done", finished

        events = read_events(run_dir)
        fragment_finished = node_event(events, "fragment.finished")
        assert fragment_finished["outcome"] == "fail", fragment_finished
    with_tmp(run)


def test_resume_and_inspect_expose_durable_nested_evidence_across_processes():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-pass")
        wf = write_workflow(tmp, "runtime-pass", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        midpoint = resume(run_dir, home, max_steps=1)
        assert midpoint.returncode == 0, midpoint.stderr
        mid_run = json.loads(midpoint.stdout)["run"]
        assert mid_run["state"] == "record", mid_run
        assert mid_run["status"] == "running", mid_run

        # A fresh process inspecting the parent run sees the attempt count
        # advanced past the one atomic fragment step.
        parent = inspect(run_dir, home)
        assert parent["run"]["attempt"] == 2, parent

        nested_dir = nested_run_dir(run_dir)
        nested_state = inspect(nested_dir, home)
        assert nested_state["run"]["status"] == "done", nested_state
        assert nested_state["run"]["state"] == "done", nested_state

        nested_events = read_events(nested_dir)
        assert any(e.get("event") == "node.started" for e in nested_events), nested_events
        assert any(e.get("event") == "run.finished" for e in nested_events), nested_events

        pin = read_json(nested_dir / "pin.json")
        assert pin["package_path"].endswith(".tesseraft/fragments/runtime-pass/fragment.edn"), pin

        final = resume(run_dir, home)
        assert final.returncode == 0, final.stderr
        finished = json.loads(final.stdout)["run"]
        assert finished["state"] == "done", finished
        assert finished["status"] == "done", finished

        # The nested fragment run's own state.edn lives under the parent run
        # dir (fragments/<state>/<attempt>/state.edn) and must not surface as
        # a second, phantom entry in the control plane's run inventory.
        # control-plane's top-level options (--workspace-root among them) are
        # only consumed *before* the command word; a fresh process passing it
        # after "runs" would fall back to the cwd-relative default and leak
        # unrelated runs from the repo's own .agent-runs.
        cp = control_plane(["--workspace-root", str(tmp), "runs"], home)
        assert cp.returncode == 0, cp.stderr
        runs = json.loads(cp.stdout)["runs"]
        assert len(runs) == 1, runs
    with_tmp(run)


def test_deleted_package_yields_durable_fragment_unresolved_with_no_nested_execution():
    def run(tmp):
        home = tmp / "home"
        package = stage_fragment(tmp, "runtime-pass")
        wf = write_workflow(tmp, "runtime-pass", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        shutil.rmtree(package.parent)

        proc = resume(run_dir, home)
        assert proc.returncode != 0, proc.stdout

        events = read_events(run_dir)
        failed = node_event(events, "node.failed")
        result = failed["result"]
        assert result.get("error_type") == "fragment_unresolved", result
        assert not (run_dir / "fragments").exists(), "no nested run dir may exist"
    with_tmp(run)


def test_unsupported_internal_node_type_is_rejected_before_any_internal_execution():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-timer")
        wf = write_workflow(tmp, "runtime-timer", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        proc = resume(run_dir, home)
        assert proc.returncode != 0, proc.stdout

        events = read_events(run_dir)
        failed = node_event(events, "node.failed")
        result = failed["result"]
        assert result.get("error_type") == "fragment_unsupported_node", result
        assert not (run_dir / "fragments").exists(), "no nested run dir may exist"
    with_tmp(run)


def test_fragment_local_max_rounds_fails_durably_without_advancing_parent_round():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-rounds")
        wf = write_workflow(tmp, "runtime-rounds", '[{:when {:fragment/outcome "looped"} :next :record}]')
        run_dir = start(tmp, home, wf)

        proc = resume(run_dir, home)
        assert proc.returncode != 0, proc.stdout

        parent_state = (run_dir / "state.edn").read_text()
        assert ':status "failed"' in parent_state, parent_state
        assert ':round 1' in parent_state, parent_state

        events = read_events(run_dir)
        failed = node_event(events, "node.failed")
        result = failed["result"]
        assert result.get("error_type") == "fragment_max_rounds", result

        nested_dir = nested_run_dir(run_dir)
        nested_state = nested_dir / "state.edn"
        assert nested_state.exists()
        nested_text = nested_state.read_text()
        assert ':status "failed"' in nested_text, nested_text
        assert ':round 3' in nested_text, nested_text

        nested_events = read_events(nested_dir)
        exceeded = [e for e in nested_events if e.get("event") == "run.max-rounds-exceeded"]
        assert len(exceeded) == 1, nested_events
        assert exceeded[0]["round"] == 3 and exceeded[0]["max_rounds"] == 2, exceeded
    with_tmp(run)


def test_unrouted_internal_result_preserves_original_cause_instead_of_step_budget_message():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-unrouted")
        wf = write_workflow(tmp, "runtime-unrouted", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        proc = resume(run_dir, home)
        assert proc.returncode != 0, proc.stdout

        # The internal :start node itself finished fine (:noop/succeed
        # returned {:status "ok"}); it is choose-transition, called from
        # step! *after* execute-node! returns, that finds no transition
        # whose :when matches that result and throws. Nothing durably
        # records this inside the nested run: no internal node.failed, and
        # the nested run never reaches a terminal status.
        nested_dir = nested_run_dir(run_dir)
        nested_events = read_events(nested_dir)
        assert any(e.get("event") == "node.finished" and e.get("state") == "start" for e in nested_events), nested_events
        assert not any(e.get("event") == "node.failed" for e in nested_events), nested_events
        nested_state = nested_dir / "state.edn"
        assert nested_state.exists()
        assert ':status "running"' in nested_state.read_text(), nested_state.read_text()

        # The parent must see the real cause, not a masked step-budget
        # message: the original "No transition matched result" propagates
        # out of the nested run and into the parent's own node.failed.
        events = read_events(run_dir)
        failed = node_event(events, "node.failed")
        result = failed["result"]
        assert result.get("message") == "No transition matched result", result
        assert result.get("error_type") != "fragment_internal_failure", result
        assert "step budget" not in (result.get("message") or ""), result
    with_tmp(run)


def test_bound_input_and_parameter_override_reach_nested_durable_evidence():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-bound")
        # The package's own :interface declares :message required and
        # :max-rounds default 2; this parent node binds :message from the
        # parent's own {{inputs.echo}} and overrides :max-rounds to 4 (not the
        # package default), so the fragment loop keeps going past round 2.
        workflow = '''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "fragment-runtime-runtime-bound"}
 :initial :run-fragment
 :states
 {:run-fragment
  {:type :fragment
   :fragment "runtime-bound"
   :inputs {:message "{{inputs.echo}}"}
   :parameters {:max-rounds 4}
   :transitions [{:when {:fragment/outcome "looped"} :next :record}]}
  :record
  {:type :deterministic
   :handler :noop/succeed
   :next :done}
  :done {:type :terminal :status :success}
  :declared-failure {:type :terminal :status :failure}}}
'''
        wf = tmp / "workflow.edn"
        wf.write_text(workflow)

        run_dir = start(tmp, home, wf, inputs={"echo": "distinct-bound-value"})
        proc = resume(run_dir, home)
        assert proc.returncode != 0, proc.stdout

        nested_dir = nested_run_dir(run_dir)
        pin = read_json(nested_dir / "pin.json")
        # Rendered, parent-derived value — not the raw "{{inputs.echo}}"
        # template text — is what reaches the nested run's durable evidence.
        assert pin["bindings"]["inputs"]["message"] == "distinct-bound-value", pin
        assert pin["bindings"]["parameters"]["max-rounds"] == 4, pin

        # The parameter override (4), not the package's own default (2),
        # governs nested round-exhaustion behavior.
        nested_events = read_events(nested_dir)
        exceeded = [e for e in nested_events if e.get("event") == "run.max-rounds-exceeded"]
        assert len(exceeded) == 1, nested_events
        assert exceeded[0]["round"] == 5 and exceeded[0]["max_rounds"] == 4, exceeded
    with_tmp(run)


def test_cancel_reaps_a_process_owned_by_a_fragment_internal_run_dir():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-pass")
        wf = write_workflow(tmp, "runtime-pass", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        # A fragment step is atomic, so this single step both fully executes
        # the nested run to completion and leaves the *parent* run itself
        # non-terminal (state :record, status "running") -- the exact window
        # in which a detached process a nested :deterministic handler started
        # must still be reachable by the parent's own cancel/cleanup.
        midpoint = resume(run_dir, home, max_steps=1)
        assert midpoint.returncode == 0, midpoint.stderr
        mid_run = json.loads(midpoint.stdout)["run"]
        assert mid_run["state"] == "record" and mid_run["status"] == "running", mid_run

        nested_dir = nested_run_dir(run_dir)
        assert nested_dir.is_dir()

        # Stand in for a detached process a fragment-internal :deterministic
        # handler would have started: run-owner-env marks it with the
        # *nested* run dir, not the parent's (runtime/core.clj run-fragment-node!
        # executes handlers over the nested ctx), so this reproduces the exact
        # marker shape owned-process-handles must match against the parent.
        env = os.environ.copy()
        env["AGENT_RUN_DIR"] = str(nested_dir)
        proc = subprocess.Popen(["sleep", "30"], env=env, start_new_session=True)
        try:
            assert proc.poll() is None, "spawned marker process exited early"

            cancelled = tesseraft(["run", "cancel", "--run-dir", str(run_dir), "--format", "json"], home)
            assert cancelled.returncode == 0, cancelled.stderr

            proc.wait(timeout=5)
            assert proc.returncode is not None, "cancel must reap a process owned by a nested fragment run dir"
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
    with_tmp(run)


def test_run_id_named_fragments_is_not_hidden_from_control_plane_inventory():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-pass")
        wf = write_workflow(tmp, "runtime-pass", '[{:when {:fragment/outcome "pass"} :next :record}]')
        # A top-level run whose *run id* (not workflow name) is literally
        # "fragments" must not be mistaken for a nested
        # fragments/<state>/<attempt> run dir and dropped from the inventory.
        run_dir = start(tmp, home, wf, run_id="fragments")
        assert run_dir.name == "fragments", run_dir

        proc = resume(run_dir, home)
        assert proc.returncode == 0, proc.stderr

        cp = control_plane(["--workspace-root", str(tmp), "runs"], home)
        assert cp.returncode == 0, cp.stderr
        runs = json.loads(cp.stdout)["runs"]
        assert [r["run_id"] for r in runs] == ["fragments"], runs

        resolved = control_plane(["--workspace-root", str(tmp), "run", "fragments"], home)
        assert resolved.returncode == 0, resolved.stderr
        assert json.loads(resolved.stdout)["run"]["run_id"] == "fragments", resolved.stdout
    with_tmp(run)


if __name__ == "__main__":
    test_runtime_pass_fixture_takes_the_parent_success_route()
    test_runtime_fail_fixture_takes_the_declared_failure_route()
    test_resume_and_inspect_expose_durable_nested_evidence_across_processes()
    test_deleted_package_yields_durable_fragment_unresolved_with_no_nested_execution()
    test_unsupported_internal_node_type_is_rejected_before_any_internal_execution()
    test_fragment_local_max_rounds_fails_durably_without_advancing_parent_round()
    test_unrouted_internal_result_preserves_original_cause_instead_of_step_budget_message()
    test_bound_input_and_parameter_override_reach_nested_durable_evidence()
    test_cancel_reaps_a_process_owned_by_a_fragment_internal_run_dir()
    test_run_id_named_fragments_is_not_hidden_from_control_plane_inventory()
    print("ok")
