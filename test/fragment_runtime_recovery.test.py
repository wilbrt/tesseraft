#!/usr/bin/env python3
"""FI8: durable resume, orphan recovery, and cancellation across interruption
of a non-approval {:type :fragment} node.

Each case stages a checked-in fixture from
test/fixtures/valid/fragment-runtime/ into a temp project (package resolution
only finds an ancestor .tesseraft/fragments/<name>/), writes a small parent
workflow around it, and drives ./bin/tesseraft as a separate process so
evidence is asserted from durable state.edn / events.jsonl / pin.json rather
than in-memory state. The restart and orphan cases additionally launch
`run resume` in the background, poll for durable evidence that a nested node
is in flight, and SIGKILL the runtime process recorded in runtime-process.json
to reproduce a genuine mid-fragment interruption; the cancel case instead
drives `run cancel` as a live operator action against the same in-flight
window.
"""
import json
import os
import shutil
import signal
import time
from pathlib import Path

from python_support import read_json, run_control_plane, run_tesseraft, start_tesseraft, with_temp_dir

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "test" / "fixtures" / "valid" / "fragment-runtime"


def with_tmp(fn):
    return with_temp_dir("tesseraft-fi8-", fn)


def tesseraft(args, home, extra_env=None):
    return run_tesseraft(args, home, extra_env)


def tesseraft_bg(args, home, extra_env=None):
    return start_tesseraft(args, home, extra_env)


def control_plane(args, home):
    return run_control_plane(args, home)


def stage_fragment(tmp, name):
    """Copy the whole checked-in fixture directory (fragment.edn plus any
    package-relative assets: scripts, prompts) with shutil.copytree so the
    script executable bit survives."""
    src = FIXTURES / name
    dest_dir = tmp / ".tesseraft" / "fragments" / name
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    shutil.copytree(src, dest_dir)
    return dest_dir / "fragment.edn"


def write_workflow(tmp, fragment_name, transitions_edn, state_id="run-fragment"):
    workflow = f'''{{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {{:name "fragment-runtime-recovery-{fragment_name}"}}
 :initial :{state_id}
 :states
 {{:{state_id}
   {{:type :fragment
    :fragment "{fragment_name}"
    :transitions {transitions_edn}}}
  :record
  {{:type :deterministic
   :handler :noop/succeed
   :next :done}}
  :done {{:type :terminal :status :success}}}}}}
'''
    path = tmp / "workflow.edn"
    path.write_text(workflow)
    return path


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


def resume(run_dir, home, max_steps=None, extra_env=None):
    args = ["run", "resume", "--run-dir", str(run_dir), "--format", "json"]
    if max_steps is not None:
        args += ["--max-steps", str(max_steps)]
    return tesseraft(args, home, extra_env)


def resume_bg(run_dir, home, extra_env=None):
    return tesseraft_bg(["run", "resume", "--run-dir", str(run_dir), "--format", "json"], home, extra_env)


def runtime_process_pid(run_dir):
    return read_json(run_dir / "runtime-process.json")["pid"]


def wait_for(predicate, timeout=15.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def wait_for_pid(path, timeout=15.0, interval=0.05):
    """Poll `path` for parseable pid content rather than mere existence: a
    pidfile writer that O_TRUNCs before writing leaves the file existing but
    empty for a short window, which would otherwise raise ValueError instead
    of timing out cleanly."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return int(path.read_text())
        except (FileNotFoundError, ValueError):
            time.sleep(interval)
    return None


def node_event(events, event, state="run-fragment"):
    matches = [e for e in events if e.get("event") == event and e.get("state") == state]
    assert matches, (event, state, events)
    return matches[-1]


def kill_pid_if_alive(pid):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def write_pi_stub(path):
    path.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'echo call >> "$PI_STUB_CALLS"\n'
        'mkdir -p "$AGENT_RUN_DIR/agent"\n'
        'echo $$ > "$AGENT_RUN_DIR/agent/stub.pid"\n'
        'printf \'{"status":"pass","ok":true}\' > "$AGENT_RUN_DIR/agent/status.json"\n'
        "sleep 300\n"
    )
    path.chmod(0o755)


def write_fast_pi_stub(path):
    """Unlike write_pi_stub, exits immediately after writing its status
    artifact so a resume driving it runs to full completion in one call, with
    nothing to interrupt."""
    path.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'echo call >> "$PI_STUB_CALLS"\n'
        'mkdir -p "$AGENT_RUN_DIR/agent"\n'
        'printf \'{"status":"pass","ok":true}\' > "$AGENT_RUN_DIR/agent/status.json"\n'
    )
    path.chmod(0o755)


def seed_completed_fragment_run(tmp, home):
    """Run the runtime-resume fixture to full, uninterrupted completion once
    (its own isolated workspace under tmp/seed) and return the resulting real
    nested attempt directory (state.edn, pin.json, events.jsonl, marks.txt),
    for tests that need a *different* parent run to see an already-terminal
    nested run the very first time it inspects that state+attempt."""
    seed_root = tmp / "seed"
    seed_root.mkdir(parents=True, exist_ok=True)
    stage_fragment(seed_root, "runtime-resume")
    wf = write_workflow(seed_root, "runtime-resume", '[{:when {:fragment/outcome "pass"} :next :record}]')
    run_dir = start(seed_root, home, wf)

    pi_stub = seed_root / "pi-stub.sh"
    calls_file = seed_root / "pi-calls.log"
    write_fast_pi_stub(pi_stub)

    resumed = resume(run_dir, home, extra_env={"PI_BIN": str(pi_stub), "PI_STUB_CALLS": str(calls_file)})
    assert resumed.returncode == 0, resumed.stderr
    finished = json.loads(resumed.stdout)["run"]
    assert finished["status"] == "done", finished

    return nested_run_dir(run_dir)


def clone_completed_nested_run(seed_dir: Path, dest_dir: Path):
    """Place a copy of a real completed nested run at dest_dir, standing in
    for what a genuine interruption between the nested run reaching its own
    terminal status and the parent recording finish! would leave on disk: a
    fragments/<state>/<attempt>/ directory that is already durably terminal
    even though the destination parent run has never executed that fragment
    step. The seed's own absolute nested-run-dir path is embedded in its
    state.edn/pin.json/events.jsonl (:run :dir, :internal_dir, ...), so it is
    rewritten to dest_dir's path everywhere it appears."""
    dest_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(seed_dir, dest_dir)
    old, new = str(seed_dir), str(dest_dir)
    for path in dest_dir.rglob("*"):
        if path.is_file():
            text = path.read_text()
            if old in text:
                path.write_text(text.replace(old, new))


def test_forced_restart_recovers_the_interrupted_agent_node_without_reinvoking_it():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-resume")
        wf = write_workflow(tmp, "runtime-resume", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        pi_stub = tmp / "pi-stub.sh"
        calls_file = tmp / "pi-calls.log"
        write_pi_stub(pi_stub)
        extra_env = {"PI_BIN": str(pi_stub), "PI_STUB_CALLS": str(calls_file)}

        nested_dir = nested_run_dir(run_dir)
        status_path = nested_dir / "agent" / "status.json"
        stub_pid_path = nested_dir / "agent" / "stub.pid"
        marks_path = nested_dir / "marks.txt"

        proc = resume_bg(run_dir, home, extra_env)
        stub_pid = None
        try:
            assert wait_for(lambda: status_path.exists()), "agent stub never wrote its status artifact"
            stub_pid = int(stub_pid_path.read_text())
            # Give the stub a moment to reach its own `sleep 300` past the
            # status-artifact write, so the kill below lands mid-sleep rather
            # than mid-write.
            time.sleep(0.2)

            pid = runtime_process_pid(run_dir)
            os.kill(pid, signal.SIGKILL)
            proc.wait(timeout=10)
            proc = None

            assert marks_path.read_text().splitlines() == ["mark"], marks_path.read_text()
            assert calls_file.read_text().splitlines() == ["call"], calls_file.read_text()

            resumed = resume(run_dir, home, extra_env=extra_env)
            assert resumed.returncode == 0, resumed.stderr
            finished = json.loads(resumed.stdout)["run"]
            assert finished["state"] == "done", finished
            assert finished["status"] == "done", finished

            # The stub was never invoked a second time: the interrupted agent
            # node was recovered from its already-written status artifact, not
            # re-executed.
            assert calls_file.read_text().splitlines() == ["call"], calls_file.read_text()
            assert marks_path.read_text().splitlines() == ["mark"], marks_path.read_text()

            events = read_events(run_dir)
            node_event(events, "fragment.resumed")

            nested_events = read_events(nested_dir)
            node_event(nested_events, "node.recovered", state="execute")
        finally:
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            if stub_pid is not None:
                kill_pid_if_alive(stub_pid)
    with_tmp(run)


def test_forced_restart_during_a_process_node_orphans_the_internal_run():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-hang")
        wf = write_workflow(tmp, "runtime-hang", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        nested_dir = nested_run_dir(run_dir)
        marks_path = nested_dir / "marks.txt"
        hang_pid_path = nested_dir / "hang.pid"

        proc = resume_bg(run_dir, home)
        hang_pid = None
        try:
            hang_pid = wait_for_pid(hang_pid_path)
            assert hang_pid is not None, "hang script never wrote its pidfile"

            pid = runtime_process_pid(run_dir)
            os.kill(pid, signal.SIGKILL)
            proc.wait(timeout=10)
            proc = None

            assert marks_path.read_text().splitlines() == ["mark"], marks_path.read_text()

            resumed = resume(run_dir, home)
            assert resumed.returncode != 0, resumed.stdout

            # No completed effect is replayed: :mark never re-runs.
            assert marks_path.read_text().splitlines() == ["mark"], marks_path.read_text()

            nested_events = read_events(nested_dir)
            node_event(nested_events, "node.orphaned", state="hang")

            events = read_events(run_dir)
            mirrored = node_event(events, "fragment.node.orphaned")
            assert mirrored.get("internal_state") == "hang", mirrored

            failed = node_event(events, "node.failed")
            assert failed["result"].get("error_type") == "fragment_internal_failure", failed
        finally:
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            if hang_pid is not None:
                kill_pid_if_alive(hang_pid)
    with_tmp(run)


def test_cancel_while_a_process_node_sleeps_cancels_both_runs_and_mirrors_it():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-hang")
        wf = write_workflow(tmp, "runtime-hang", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        nested_dir = nested_run_dir(run_dir)
        hang_pid_path = nested_dir / "hang.pid"

        proc = resume_bg(run_dir, home)
        hang_pid = None
        try:
            hang_pid = wait_for_pid(hang_pid_path)
            assert hang_pid is not None, "hang script never wrote its pidfile"

            cancelled = tesseraft(["run", "cancel", "--run-dir", str(run_dir), "--format", "json"], home)
            assert cancelled.returncode == 0, cancelled.stderr

            proc.wait(timeout=10)
            proc = None

            assert ':status "cancelled"' in (run_dir / "state.edn").read_text()
            assert ':status "cancelled"' in (nested_dir / "state.edn").read_text()

            # cancel! blocks until stop-runtime-process! confirms every
            # descendant (including the hang script) exited or was forced to,
            # and proc.wait above already confirmed the resume process itself
            # is gone, so the hang pid must already be dead here.
            assert not pid_alive(hang_pid), "hang process must be reaped by cancel"

            events = read_events(run_dir)
            # The top-level run.cancelled event carries no :state (it is not
            # associated with any single node), unlike node_event's default.
            assert any(e.get("event") == "run.cancelled" for e in events), events
            mirrored = [e for e in events if e.get("event") == "fragment.run.cancelled"]
            assert mirrored, events

            run_id = run_dir.name
            resolved = control_plane(["--workspace-root", str(tmp), "run", run_id], home)
            assert resolved.returncode == 0, resolved.stderr
            attempts = json.loads(resolved.stdout)["run"]["attempts"]
            fragment_attempt = next(a for a in attempts if a.get("state") == "run-fragment")
            internal_attempts = fragment_attempt.get("internal_attempts")
            assert internal_attempts, fragment_attempt
            # unmirror-fragment-event -> derive-attempts-from-events must
            # reconstruct both internal states in execution order, with
            # :mark's completion (finished before the cancel landed) surviving
            # the round trip and :hang left non-terminal (killed mid-run).
            assert [a.get("node_id") for a in internal_attempts] == ["mark", "hang"], internal_attempts
            assert [a.get("state") for a in internal_attempts] == ["mark", "hang"], internal_attempts
            mark_attempt, hang_attempt = internal_attempts
            assert mark_attempt.get("status") == "ok", mark_attempt
            assert mark_attempt.get("finished_at"), mark_attempt
            assert not hang_attempt.get("finished_at"), hang_attempt

            artifacts_resolved = control_plane(["--workspace-root", str(tmp), "artifacts", run_id], home)
            assert artifacts_resolved.returncode == 0, artifacts_resolved.stderr
            artifact_paths = {a["path"] for a in json.loads(artifacts_resolved.stdout)["artifacts"]}
            for expected in (
                "fragments/run-fragment/1/state.edn",
                "fragments/run-fragment/1/events.jsonl",
                "fragments/run-fragment/1/pin.json",
            ):
                assert expected in artifact_paths, (expected, sorted(artifact_paths))
        finally:
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            if hang_pid is not None:
                kill_pid_if_alive(hang_pid)
    with_tmp(run)


def test_resuming_an_already_done_nested_run_completes_via_finish_without_reexecuting_it():
    def run(tmp):
        home = tmp / "home"
        seed_nested_dir = seed_completed_fragment_run(tmp, home)

        stage_fragment(tmp, "runtime-resume")
        wf = write_workflow(tmp, "runtime-resume", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        nested_dir = nested_run_dir(run_dir)
        clone_completed_nested_run(seed_nested_dir, nested_dir)
        nested_events_before = read_events(nested_dir)

        # This run's own parent-level state.edn has never executed the
        # fragment step: run-fragment-node! must take the durable-terminal
        # branch (straight to finish!) the very first time it looks, not the
        # fresh path -- there is no PI_BIN configured here, so a fresh
        # re-invocation of :execute would fail loudly.
        resumed = resume(run_dir, home)
        assert resumed.returncode == 0, resumed.stderr
        finished = json.loads(resumed.stdout)["run"]
        assert finished["state"] == "done", finished
        assert finished["status"] == "done", finished

        # No internal node re-ran: the nested run's own event log is
        # byte-for-byte unchanged by this resume.
        assert read_events(nested_dir) == nested_events_before, (nested_events_before, read_events(nested_dir))
        assert (nested_dir / "marks.txt").read_text().splitlines() == ["mark"]

        events = read_events(run_dir)
        node_event(events, "fragment.finished")
        # fragment.resumed is only emitted on the durable *non-terminal*
        # branch; the terminal branch never continues the nested loop.
        assert not [e for e in events if e.get("event") == "fragment.resumed"], events
    with_tmp(run)


def test_resuming_a_nested_run_whose_package_changed_since_pin_fails_with_fragment_pin_changed():
    def run(tmp):
        home = tmp / "home"
        seed_nested_dir = seed_completed_fragment_run(tmp, home)

        fragment_edn = stage_fragment(tmp, "runtime-resume")
        wf = write_workflow(tmp, "runtime-resume", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        nested_dir = nested_run_dir(run_dir)
        clone_completed_nested_run(seed_nested_dir, nested_dir)

        # The package this run-dir resolves against has changed since the
        # nested run was pinned (still the seed's own pin.json), even though
        # states/transitions/outputs are untouched.
        fragment_edn.write_text(fragment_edn.read_text() + "\n;; edited after pin\n")

        resumed = resume(run_dir, home)
        assert resumed.returncode != 0, resumed.stdout

        assert ':status "failed"' in (run_dir / "state.edn").read_text()

        events = read_events(run_dir)
        failed = node_event(events, "node.failed")
        assert failed["result"].get("error_type") == "fragment_pin_changed", failed

        # Refused before mapping the outcome or touching the nested run again.
        assert not [e for e in events if e.get("event") == "fragment.finished"], events
        assert (nested_dir / "marks.txt").read_text().splitlines() == ["mark"]
    with_tmp(run)


if __name__ == "__main__":
    test_forced_restart_recovers_the_interrupted_agent_node_without_reinvoking_it()
    test_forced_restart_during_a_process_node_orphans_the_internal_run()
    test_cancel_while_a_process_node_sleeps_cancels_both_runs_and_mirrors_it()
    test_resuming_an_already_done_nested_run_completes_via_finish_without_reexecuting_it()
    test_resuming_a_nested_run_whose_package_changed_since_pin_fails_with_fragment_pin_changed()
    print("ok")
