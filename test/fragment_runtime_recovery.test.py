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
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "test" / "fixtures" / "valid" / "fragment-runtime"


def with_tmp(fn):
    tmp = Path(tempfile.mkdtemp(prefix="tesseraft-fi8-"))
    try:
        return fn(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def tesseraft(args, home, extra_env=None):
    env = os.environ.copy()
    env["TESSERAFT_HOME"] = str(home)
    env.update(extra_env or {})
    return subprocess.run(
        [str(ROOT / "bin" / "tesseraft"), *args],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def tesseraft_bg(args, home, extra_env=None):
    env = os.environ.copy()
    env["TESSERAFT_HOME"] = str(home)
    env.update(extra_env or {})
    return subprocess.Popen(
        [str(ROOT / "bin" / "tesseraft"), *args],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
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


def write_pi_stub(path, calls_file):
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


def test_forced_restart_recovers_the_interrupted_agent_node_without_reinvoking_it():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-resume")
        wf = write_workflow(tmp, "runtime-resume", '[{:when {:fragment/outcome "pass"} :next :record}]')
        run_dir = start(tmp, home, wf)

        pi_stub = tmp / "pi-stub.sh"
        calls_file = tmp / "pi-calls.log"
        write_pi_stub(pi_stub, calls_file)
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
            assert wait_for(lambda: hang_pid_path.exists()), "hang script never wrote its pidfile"
            hang_pid = int(hang_pid_path.read_text())

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
            assert wait_for(lambda: hang_pid_path.exists()), "hang script never wrote its pidfile"
            hang_pid = int(hang_pid_path.read_text())

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
            assert fragment_attempt.get("internal_attempts"), fragment_attempt
        finally:
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            if hang_pid is not None:
                kill_pid_if_alive(hang_pid)
    with_tmp(run)


if __name__ == "__main__":
    test_forced_restart_recovers_the_interrupted_agent_node_without_reinvoking_it()
    test_forced_restart_during_a_process_node_orphans_the_internal_run()
    test_cancel_while_a_process_node_sleeps_cancels_both_runs_and_mirrors_it()
    print("ok")
