#!/usr/bin/env python3
"""FI7: agent/process/timer execution and exit-artifact projection inside
{:type :fragment} nodes.

Each case stages a checked-in fixture from
test/fixtures/valid/fragment-runtime/ into a temp project (package resolution
only finds an ancestor .tesseraft/fragments/<name>/), writes a small parent
workflow around it, and drives ./bin/tesseraft as a separate process so
evidence is asserted from durable state.edn / events.jsonl / pin.json rather
than in-memory state. Multi-file fixtures (scripts, prompt templates) are
staged with shutil.copytree so the script executable bit survives.
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
    tmp = Path(tempfile.mkdtemp(prefix="tesseraft-fi7-"))
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


def bb_eval(expr):
    return subprocess.run(
        ["bb", "-e", expr],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def stage_fragment(tmp, name):
    """Copy the whole checked-in fixture directory (fragment.edn plus any
    package-relative assets: scripts, prompts) so package-relative resolution
    resolves real files, not just the single package descriptor."""
    src = FIXTURES / name
    dest_dir = tmp / ".tesseraft" / "fragments" / name
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    shutil.copytree(src, dest_dir)
    return dest_dir / "fragment.edn"


def write_workflow(tmp, fragment_name, transitions_edn, state_id="run-fragment", extra_fields=""):
    workflow = f'''{{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {{:name "fragment-runtime-nodes-{fragment_name}"}}
 :initial :{state_id}
 :states
 {{:{state_id}
   {{:type :fragment
    :fragment "{fragment_name}"
    :transitions {transitions_edn}
    {extra_fields}}}
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


def start(tmp, home, wf, inputs=None, run_id=None, executor=None):
    args = ["run", "start", str(wf), "--workspace-root", str(tmp), "--format", "json"]
    for k, v in (inputs or {}).items():
        args += ["--input", f"{k}={v}"]
    if run_id is not None:
        args += ["--run-id", run_id]
    if executor is not None:
        args += ["--executor", executor]
    proc = tesseraft(args, home)
    assert proc.returncode == 0, proc.stderr
    return Path(json.loads(proc.stdout)["run"]["dir"])


def resume(run_dir, home, max_steps=None):
    args = ["run", "resume", "--run-dir", str(run_dir), "--format", "json"]
    if max_steps is not None:
        args += ["--max-steps", str(max_steps)]
    return tesseraft(args, home)


def node_event(events, event, state="run-fragment"):
    matches = [e for e in events if e.get("event") == event and e.get("state") == state]
    assert matches, (event, state, events)
    return matches[-1]


def test_runtime_timer_fixture_actually_sleeps_and_routes_the_parent_outcome():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-timer")
        wf = write_workflow(tmp, "runtime-timer", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)
        proc = resume(run_dir, home)
        assert proc.returncode == 0, proc.stderr
        finished = json.loads(proc.stdout)["run"]
        assert finished["state"] == "done", finished
        assert finished["status"] == "done", finished

        nested_dir = nested_run_dir(run_dir)
        nested_events = read_events(nested_dir)
        timer_finished = node_event(nested_events, "node.finished", state="wait")
        assert timer_finished["result"]["slept-ms"] == 1000, timer_finished

        events = read_events(run_dir)
        fragment_finished = node_event(events, "fragment.finished")
        assert fragment_finished["outcome"] == "pass", fragment_finished
    with_tmp(run)


def test_runtime_process_fixture_runs_the_package_script_and_routes_the_outcome():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-process")
        wf = write_workflow(tmp, "runtime-process", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)
        proc = resume(run_dir, home)
        assert proc.returncode == 0, proc.stderr
        finished = json.loads(proc.stdout)["run"]
        assert finished["state"] == "done", finished
        assert finished["status"] == "done", finished

        # The script ran from the fragment package dir (not the workflow dir)
        # and wrote its required output into the *nested* run dir.
        nested_dir = nested_run_dir(run_dir)
        result_path = nested_dir / "process" / "result.json"
        assert result_path.exists(), "script must write its required output into the nested run dir"
        assert read_json(result_path) == {"ran": True}

        events = read_events(run_dir)
        fragment_finished = node_event(events, "fragment.finished")
        assert fragment_finished["outcome"] == "pass", fragment_finished
    with_tmp(run)


def test_runtime_mock_agent_fixture_renders_package_template_with_no_credentials():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-mock-agent")
        wf = write_workflow(tmp, "runtime-mock-agent", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf, executor="mock")
        proc = resume(run_dir, home)
        assert proc.returncode == 0, proc.stderr
        finished = json.loads(proc.stdout)["run"]
        assert finished["state"] == "done", finished
        assert finished["status"] == "done", finished

        # The package prompt template (not a workflow-relative one) rendered
        # into the nested run dir with no executor credentials.
        nested_dir = nested_run_dir(run_dir)
        prompt_path = nested_dir / "prompts" / "generated" / "execute-1.md"
        assert prompt_path.exists(), "mock executor must render the package-relative prompt template"
        assert "Mock agent fixture prompt" in prompt_path.read_text()

        status_path = nested_dir / "status.json"
        assert status_path.exists()
        status = read_json(status_path)
        assert status["status"] == "pass", status

        events = read_events(run_dir)
        fragment_finished = node_event(events, "fragment.finished")
        assert fragment_finished["outcome"] == "pass", fragment_finished
    with_tmp(run)


def test_exit_output_materializes_at_the_declared_prefix():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-exit-outputs")
        wf = write_workflow(
            tmp, "runtime-exit-outputs",
            '[{:when {:fragment/outcome "pass"} :next :record}]',
            extra_fields=':prefix "included/one"',
        )
        run_dir = start(tmp, home, wf)
        proc = resume(run_dir, home)
        assert proc.returncode == 0, proc.stderr
        finished = json.loads(proc.stdout)["run"]
        assert finished["state"] == "done", finished

        # The nested run's own artifact stays where the process wrote it...
        nested_dir = nested_run_dir(run_dir)
        assert read_json(nested_dir / "artifacts" / "status.json") == {"status": "pass"}

        # ...and the reached exit entry's :produces path is also materialized
        # into the parent run dir at the inclusion's declared :prefix.
        projected = run_dir / "included" / "one" / "artifacts" / "status.json"
        assert projected.exists(), "exit output must be materialized at the declared prefix"
        assert read_json(projected) == {"status": "pass"}

        events = read_events(run_dir)
        fragment_finished = node_event(events, "fragment.finished")
        assert fragment_finished["exit_outputs"] == {"status": "included/one/artifacts/status.json"}, fragment_finished

        node_finished = node_event(events, "node.finished")
        assert node_finished["result"]["exit_outputs"] == {"status": "included/one/artifacts/status.json"}, node_finished

        index = read_json(run_dir / "fragments" / "exit-index.json")
        assert index == {"included/one/artifacts/status.json": {"state": "run-fragment", "fragment": "runtime-exit-outputs"}}, index
    with_tmp(run)


def test_two_inclusions_with_distinct_prefixes_both_materialize_independently():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-exit-outputs")
        workflow = '''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "fragment-exit-distinct-prefixes"}
 :initial :run-fragment-a
 :states
 {:run-fragment-a
  {:type :fragment
   :fragment "runtime-exit-outputs"
   :prefix "included/one"
   :transitions [{:when {:fragment/outcome "pass"} :next :run-fragment-b}]}
  :run-fragment-b
  {:type :fragment
   :fragment "runtime-exit-outputs"
   :prefix "included/two"
   :transitions [{:when {:fragment/outcome "pass"} :next :done}]}
  :done {:type :terminal :status :success}}}
'''
        wf = tmp / "workflow.edn"
        wf.write_text(workflow)

        run_dir = start(tmp, home, wf)
        proc = resume(run_dir, home)
        assert proc.returncode == 0, proc.stderr
        finished = json.loads(proc.stdout)["run"]
        assert finished["state"] == "done", finished

        # Both inclusions' exit artifacts stay independently readable at
        # their own declared prefix: neither one overwrites the other.
        projected_a = run_dir / "included" / "one" / "artifacts" / "status.json"
        projected_b = run_dir / "included" / "two" / "artifacts" / "status.json"
        assert projected_a.exists(), "first inclusion's exit output must be materialized"
        assert projected_b.exists(), "second inclusion's exit output must be materialized"
        assert read_json(projected_a) == {"status": "pass"}
        assert read_json(projected_b) == {"status": "pass"}

        events = read_events(run_dir)
        finished_a = node_event(events, "fragment.finished", state="run-fragment-a")
        finished_b = node_event(events, "fragment.finished", state="run-fragment-b")
        assert finished_a["exit_outputs"] == {"status": "included/one/artifacts/status.json"}, finished_a
        assert finished_b["exit_outputs"] == {"status": "included/two/artifacts/status.json"}, finished_b
        failures = [e for e in events if e.get("event") == "node.failed"]
        assert failures == [], failures

        index = read_json(run_dir / "fragments" / "exit-index.json")
        assert index == {
            "included/one/artifacts/status.json": {"state": "run-fragment-a", "fragment": "runtime-exit-outputs"},
            "included/two/artifacts/status.json": {"state": "run-fragment-b", "fragment": "runtime-exit-outputs"},
        }, index
    with_tmp(run)


def test_two_inclusions_without_distinct_prefixes_conflict_instead_of_overwriting():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-exit-outputs")
        workflow = '''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "fragment-exit-conflict"}
 :initial :run-fragment-a
 :states
 {:run-fragment-a
  {:type :fragment
   :fragment "runtime-exit-outputs"
   :transitions [{:when {:fragment/outcome "pass"} :next :run-fragment-b}]}
  :run-fragment-b
  {:type :fragment
   :fragment "runtime-exit-outputs"
   :transitions [{:when {:fragment/outcome "pass"} :next :done}]}
  :done {:type :terminal :status :success}}}
'''
        wf = tmp / "workflow.edn"
        wf.write_text(workflow)

        run_dir = start(tmp, home, wf)
        proc = resume(run_dir, home)
        assert proc.returncode != 0, proc.stdout

        # The first inclusion's projected artifact is untouched; the second
        # inclusion, unprefixed and colliding on the same path, fails durably
        # instead of silently overwriting it.
        projected = run_dir / "artifacts" / "status.json"
        assert read_json(projected) == {"status": "pass"}

        events = read_events(run_dir)
        failed = node_event(events, "node.failed", state="run-fragment-b")
        result = failed["result"]
        assert result.get("error_type") == "fragment_exit_output_conflict", result

        index = read_json(run_dir / "fragments" / "exit-index.json")
        assert index == {"artifacts/status.json": {"state": "run-fragment-a", "fragment": "runtime-exit-outputs"}}, index

        # The second inclusion's own nested run still completed and produced
        # the artifact locally; only the parent-level projection is refused.
        # The parent :run :attempt counter is global (advance increments it on
        # every transition, not per-state), so the second inclusion's nested
        # dir is fragments/run-fragment-b/2, not .../1.
        nested_b = nested_run_dir(run_dir, state="run-fragment-b", attempt=2)
        assert read_json(nested_b / "artifacts" / "status.json") == {"status": "pass"}
    with_tmp(run)


def test_blank_prefix_exit_output_refuses_to_overwrite_a_preexisting_unowned_parent_file():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-exit-outputs")
        wf = write_workflow(tmp, "runtime-exit-outputs", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        # A parent-owned artifact already occupies the fragment's unprefixed
        # exit-output destination before the inclusion ever runs -- no entry
        # for it exists yet in fragments/exit-index.json.
        preexisting = run_dir / "artifacts" / "status.json"
        preexisting.parent.mkdir(parents=True, exist_ok=True)
        preexisting.write_text(json.dumps({"status": "parent-owned"}))

        proc = resume(run_dir, home)
        assert proc.returncode != 0, proc.stdout

        assert read_json(preexisting) == {"status": "parent-owned"}, "pre-existing parent artifact must be untouched"

        events = read_events(run_dir)
        failed = node_event(events, "node.failed")
        result = failed["result"]
        assert result.get("error_type") == "fragment_exit_output_conflict", result
        details = result.get("details") or {}
        assert details.get("owner_state") is None, result
        assert details.get("owner_fragment") is None, result

        assert not (run_dir / "fragments" / "exit-index.json").exists()
    with_tmp(run)


def test_same_inclusion_state_re_materializing_on_retry_is_not_a_conflict():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-exit-outputs")
        workflow = '''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "fragment-exit-retry-same-state"}
 :initial :run-fragment
 :states
 {:run-fragment
  {:type :fragment
   :fragment "runtime-exit-outputs"
   :transitions [{:when {:fragment/outcome "pass"} :next :run-fragment}]}
  :done {:type :terminal :status :success}}}
'''
        wf = tmp / "workflow.edn"
        wf.write_text(workflow)

        run_dir = start(tmp, home, wf)
        # A parent loop back into the same fragment inclusion state: the
        # fragment always routes "pass" to itself, so two steps re-enter
        # :run-fragment a second time as its own retry, not a new inclusion.
        proc = resume(run_dir, home, max_steps=2)
        assert proc.returncode == 0, proc.stderr
        running = json.loads(proc.stdout)["run"]
        assert running["status"] == "running", running

        projected = run_dir / "artifacts" / "status.json"
        assert read_json(projected) == {"status": "pass"}

        events = read_events(run_dir)
        finishes = [e for e in events if e.get("event") == "fragment.finished" and e.get("state") == "run-fragment"]
        assert len(finishes) == 2, events
        failures = [e for e in events if e.get("event") == "node.failed" and e.get("state") == "run-fragment"]
        assert failures == [], failures

        # Ownership stays with the one inclusion state across both attempts;
        # inverting the same-state exemption would have raised
        # fragment_exit_output_conflict on the second attempt instead.
        index = read_json(run_dir / "fragments" / "exit-index.json")
        assert index == {"artifacts/status.json": {"state": "run-fragment", "fragment": "runtime-exit-outputs"}}, index

        nested_2 = nested_run_dir(run_dir, state="run-fragment", attempt=2)
        assert read_json(nested_2 / "artifacts" / "status.json") == {"status": "pass"}
    with_tmp(run)


def test_materialize_exit_outputs_rejects_an_unsafe_produces_path_before_any_copy():
    def run(tmp):
        parent_dir = tmp / "parent"
        parent_dir.mkdir()
        nested_dir = tmp / "nested"
        nested_dir.mkdir()
        # Calls the runtime function directly (bypassing lint entirely) to
        # prove the durable runtime refusal holds even for a package that
        # predates the fragment-exit-invalid-produces-path lint rule.
        expr = (
            '(require (quote [tesseraft.runtime.fragment :as fragment]))\n'
            '(let [pkg {:metadata {:name "exit-unsafe-produces-fixture"}\n'
            '           :interface {:outputs {}}\n'
            '           :fragment {:exit [{:on :pass :produces {:status "../escape.json"}}]}}]\n'
            '  (try\n'
            '    (fragment/materialize-exit-outputs!\n'
            '      {:run {:dir "' + str(parent_dir) + '"}}\n'
            '      :run-fragment\n'
            '      pkg\n'
            '      {:prefix nil}\n'
            '      "' + str(nested_dir) + '"\n'
            '      "pass")\n'
            '    (println "no-error")\n'
            '    (catch clojure.lang.ExceptionInfo e\n'
            '      (println (:error-type (ex-data e))))))\n'
        )
        proc = bb_eval(expr)
        assert proc.returncode == 0, proc.stderr
        assert proc.stdout.strip() == "fragment_exit_output_invalid_path", (proc.stdout, proc.stderr)
        assert list(parent_dir.iterdir()) == [], "nothing may be copied when a produces path is unsafe"
    with_tmp(run)


def test_missing_required_exit_output_fails_durably_without_routing_the_parent():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-exit-outputs-missing")
        wf = write_workflow(tmp, "runtime-exit-outputs-missing", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)
        proc = resume(run_dir, home)
        assert proc.returncode != 0, proc.stdout

        # The nested run itself completed fine -- nothing internal ever
        # required the "status.json" path, so it is finish! discovering the
        # declared-but-absent exit artifact that fails, not internal
        # execution.
        nested_dir = nested_run_dir(run_dir)
        assert ':status "done"' in (nested_dir / "state.edn").read_text()

        events = read_events(run_dir)
        failed = node_event(events, "node.failed")
        result = failed["result"]
        assert result.get("error_type") == "fragment_exit_output_missing", result

        assert not (run_dir / "status.json").exists(), "no artifact may be projected when a required output is missing"
        assert not (run_dir / "fragments" / "exit-index.json").exists()
    with_tmp(run)


def test_bounded_retry_loop_terminates_at_its_own_max_rounds_without_moving_the_parent_round():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-retry-loop")
        wf = write_workflow(tmp, "runtime-retry-loop", '[{:when {:fragment/outcome "looped"} :next :record}]')
        run_dir = start(tmp, home, wf)
        proc = resume(run_dir, home)
        assert proc.returncode == 0, proc.stderr
        finished = json.loads(proc.stdout)["run"]
        assert finished["state"] == "done", finished
        assert finished["status"] == "done", finished

        # The parent round counter is untouched by the fragment's own
        # internal retries -- only its own :inc-round effects moved.
        parent_state = (run_dir / "state.edn").read_text()
        assert ':round 1' in parent_state, parent_state

        nested_dir = nested_run_dir(run_dir)
        nested_state = nested_dir / "state.edn"
        assert ':status "done"' in nested_state.read_text(), nested_state.read_text()
        assert ':round 3' in nested_state.read_text(), nested_state.read_text()

        events = read_events(run_dir)
        fragment_finished = node_event(events, "fragment.finished")
        assert fragment_finished["outcome"] == "looped", fragment_finished
        assert fragment_finished["internal_rounds"] == 3, fragment_finished

        nested_events = read_events(nested_dir)
        retries = [e for e in nested_events if e.get("event") == "node.finished" and e.get("state") == "retry"]
        assert len(retries) == 3, nested_events
    with_tmp(run)


if __name__ == "__main__":
    test_runtime_timer_fixture_actually_sleeps_and_routes_the_parent_outcome()
    test_runtime_process_fixture_runs_the_package_script_and_routes_the_outcome()
    test_runtime_mock_agent_fixture_renders_package_template_with_no_credentials()
    test_exit_output_materializes_at_the_declared_prefix()
    test_two_inclusions_with_distinct_prefixes_both_materialize_independently()
    test_two_inclusions_without_distinct_prefixes_conflict_instead_of_overwriting()
    test_blank_prefix_exit_output_refuses_to_overwrite_a_preexisting_unowned_parent_file()
    test_same_inclusion_state_re_materializing_on_retry_is_not_a_conflict()
    test_materialize_exit_outputs_rejects_an_unsafe_produces_path_before_any_copy()
    test_missing_required_exit_output_fails_durably_without_routing_the_parent()
    test_bounded_retry_loop_terminates_at_its_own_max_rounds_without_moving_the_parent_round()
    print("ok")
