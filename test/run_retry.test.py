#!/usr/bin/env python3
"""Run retry recovery tests for the `run retry` command.

Drives the real ./bin/tesseraft CLI in temp workspaces and asserts on durable
state.edn / events.jsonl, matching the runtime-fragment recovery test style.
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
    tmp = Path(tempfile.mkdtemp(prefix="tesseraft-retry-"))
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


def start(tmp, home, wf, run_id=None):
    args = ["run", "start", str(wf), "--workspace-root", str(tmp), "--format", "json"]
    if run_id is not None:
        args += ["--run-id", run_id]
    proc = tesseraft(args, home)
    assert proc.returncode == 0, proc.stderr
    return Path(json.loads(proc.stdout)["run"]["dir"])


def step(run_dir, home, extra_env=None):
    return tesseraft(["run", "step", "--run-dir", str(run_dir), "--format", "json"], home, extra_env=extra_env)


def resume(run_dir, home, max_steps=None, extra_env=None):
    args = ["run", "resume", "--run-dir", str(run_dir), "--format", "json"]
    if max_steps is not None:
        args += ["--max-steps", str(max_steps)]
    return tesseraft(args, home, extra_env=extra_env)


def retry(run_dir, home, max_steps=None, reason=None, repin=False, extra_env=None):
    args = ["run", "retry", "--run-dir", str(run_dir), "--format", "json"]
    if max_steps is not None:
        args += ["--max-steps", str(max_steps)]
    if reason is not None:
        args += ["--reason", reason]
    if repin:
        args += ["--repin"]
    return tesseraft(args, home, extra_env=extra_env)


def read_json(path):
    return json.loads(path.read_text())


def read_events(run_dir):
    p = run_dir / "events.jsonl"
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


def wait_for(predicate, timeout=15.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def wait_for_pid(path, timeout=15.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return int(path.read_text())
        except (FileNotFoundError, ValueError):
            time.sleep(interval)
    return None


def runtime_process_pid(run_dir):
    return read_json(run_dir / "runtime-process.json")["pid"]


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


def write_workflow(tmp, states_edn, state_id="boom", name="retry-fixture"):
    workflow = f"""{{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {{:name "{name}"}}
 :defaults {{:max-rounds 1 :state-timeout "1m"}}
 :policies {{:require-timeouts true :require-max-rounds true}}
 :initial :{state_id}
 :states
 {states_edn}}}
"""
    path = tmp / "workflow.edn"
    path.write_text(workflow)
    return path


def write_attempt_script(path):
    """Process node that fails on attempt 1 and succeeds on later attempts.
    Records each invocation in script-calls.jsonl."""
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys, os\n"
        "data = json.load(sys.stdin)\n"
        "attempt = data['run']['attempt']\n"
        "run_dir = data['paths']['run_dir']\n"
        "marker = os.path.join(run_dir, 'script-calls.jsonl')\n"
        "with open(marker, 'a') as f:\n"
        "    f.write(json.dumps({'attempt': attempt}) + '\\n')\n"
        "if attempt == 1:\n"
        "    print('failing on attempt 1', file=sys.stderr)\n"
        "    sys.exit(7)\n"
        "print(json.dumps({'status': 'ok', 'ok': True}))\n"
    )
    path.chmod(0o755)


def write_hang_then_succeed_script(path):
    """Process node that hangs on attempt 1 and succeeds on later attempts."""
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys, os, time\n"
        "data = json.load(sys.stdin)\n"
        "attempt = data['run']['attempt']\n"
        "run_dir = data['paths']['run_dir']\n"
        "if attempt == 1:\n"
        "    pidfile = os.path.join(run_dir, 'hang.pid')\n"
        "    with open(pidfile, 'w') as f:\n"
        "        f.write(str(os.getpid()))\n"
        "    time.sleep(300)\n"
        "    print(json.dumps({'status': 'ok', 'ok': True}))\n"
        "else:\n"
        "    print(json.dumps({'status': 'ok', 'ok': True}))\n"
    )
    path.chmod(0o755)


def write_pi_stub(path, fail_first=True):
    """PI stub that writes the status artifact and exits nonzero on first call
    if fail_first is True, so the run fails with the status artifact present."""
    path.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f'echo call >> "$PI_STUB_CALLS"\n'
        "mkdir -p \"$AGENT_RUN_DIR/agent\"\n"
        "printf '{\"status\":\"pass\",\"ok\":true,\"summary\":\"stubbed\"}' > \"$AGENT_RUN_DIR/agent/status.json\"\n"
        f'if [ "${{FAIL_FIRST:-{("yes" if fail_first else "no")}}}" = "yes" ] && [ ! -f "$AGENT_RUN_DIR/agent/stub-failed-once" ]; then\n'
        "  touch \"$AGENT_RUN_DIR/agent/stub-failed-once\"\n"
        "  exit 1\n"
        "fi\n"
        "exit 0\n"
    )
    path.chmod(0o755)


def test_retry_after_process_failure_re_executes_and_appends_recovery_event():
    def run(tmp):
        home = tmp / "home"
        script = tmp / "attempt.py"
        write_attempt_script(script)
        states = (
            "{:boom {:type :process :title \"Failing process\" :command [\"bash\" \"-lc\" \"python3 "
            + str(script).replace("\\", "\\\\")
            + "\"] :runtime {:timeout \"10s\"} :next :done} :done {:type :terminal :status :success}}"
        )
        wf = write_workflow(tmp, states)
        run_dir = start(tmp, home, wf)

        failed = step(run_dir, home)
        assert failed.returncode != 0, failed.stdout
        assert ':status "failed"' in (run_dir / "state.edn").read_text()
        events = read_events(run_dir)
        assert [e for e in events if e.get("event") == "node.started" and e.get("attempt") == 1]
        assert [e for e in events if e.get("event") == "node.failed"]
        assert len([e for e in events if e.get("event") == "node.started"]) == 1

        retried = retry(run_dir, home, reason="transient failure")
        assert retried.returncode == 0, retried.stderr
        finished = json.loads(retried.stdout)["run"]
        assert finished["status"] == "done", finished
        assert finished["attempt"] == 2, finished

        events = read_events(run_dir)
        started = [e for e in events if e.get("event") == "node.started"]
        assert len(started) == 2, [e.get("attempt") for e in started]
        assert {e.get("attempt") for e in started} == {1, 2}

        recovery = [e for e in events if e.get("event") == "run.recovery"]
        assert len(recovery) == 1, events
        assert recovery[0]["prior_status"] == "failed"
        assert recovery[0]["new_attempt"] == 2
        assert recovery[0]["reason"] == "transient failure"
        assert recovery[0].get("prior_evidence", {}).get("event") == "node.failed"

        calls = [json.loads(line) for line in (run_dir / "script-calls.jsonl").read_text().splitlines()]
        assert [c["attempt"] for c in calls] == [1, 2], calls

    with_tmp(run)


def write_succeed_script(path):
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        "print(json.dumps({'status': 'ok', 'ok': True}))\n"
    )
    path.chmod(0o755)


def test_retry_refuses_running():
    def run(tmp):
        home = tmp / "home"
        script = tmp / "succeed.py"
        write_succeed_script(script)
        states = (
            "{:boom {:type :process :title \"Succeed\" :command [\"bash\" \"-lc\" \"python3 "
            + str(script).replace("\\", "\\\\")
            + "\"] :runtime {:timeout \"10s\"} :next :done} :done {:type :terminal :status :success}}"
        )
        wf = write_workflow(tmp, states)
        run_dir = start(tmp, home, wf)

        running = retry(run_dir, home)
        assert running.returncode != 0, running.stdout
        assert "retry_requires_failed_or_cancelled" in running.stderr, running.stderr

    with_tmp(run)


def test_retry_refuses_done():
    def run(tmp):
        home = tmp / "home"
        script = tmp / "succeed.py"
        write_succeed_script(script)
        states = (
            "{:boom {:type :process :title \"Succeed\" :command [\"bash\" \"-lc\" \"python3 "
            + str(script).replace("\\", "\\\\")
            + "\"] :runtime {:timeout \"10s\"} :next :done} :done {:type :terminal :status :success}}"
        )
        wf = write_workflow(tmp, states)
        run_dir = start(tmp, home, wf)

        completed = resume(run_dir, home)
        assert completed.returncode == 0, completed.stderr
        assert json.loads(completed.stdout)["run"]["status"] == "done"

        done = retry(run_dir, home)
        assert done.returncode != 0, done.stdout
        assert "retry_requires_failed_or_cancelled" in done.stderr, done.stderr

    with_tmp(run)


def test_retry_refuses_live_process():
    def run(tmp):
        home = tmp / "home"
        script = tmp / "hang.py"
        write_hang_then_succeed_script(script)
        states = (
            "{:boom {:type :process :title \"Hang\" :command [\"bash\" \"-lc\" \"python3 "
            + str(script).replace("\\", "\\\\")
            + "\"] :runtime {:timeout \"10s\"} :next :done} :done {:type :terminal :status :success}}"
        )
        wf = write_workflow(tmp, states)
        run_dir = start(tmp, home, wf)

        proc = tesseraft_bg(["run", "resume", "--run-dir", str(run_dir), "--format", "json"], home)
        hang_pid = None
        try:
            hang_pid = wait_for_pid(run_dir / "hang.pid")
            assert hang_pid is not None, "hang script never wrote pidfile"
            wait_for(lambda: (run_dir / "runtime-process.json").exists())

            rejected = retry(run_dir, home)
            assert rejected.returncode != 0, rejected.stdout
            assert "retry_live_process" in rejected.stderr, rejected.stderr

            pid = runtime_process_pid(run_dir)
            os.kill(pid, signal.SIGKILL)
            proc.wait(timeout=10)
            proc = None
        finally:
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            if hang_pid is not None:
                kill_pid_if_alive(hang_pid)

    with_tmp(run)


def test_retry_refuses_pin_mismatch_and_repin_proceeds():
    def run(tmp):
        home = tmp / "home"
        script = tmp / "attempt.py"
        write_attempt_script(script)
        states = (
            "{:boom {:type :process :title \"Failing process\" :command [\"bash\" \"-lc\" \"python3 "
            + str(script).replace("\\", "\\\\")
            + "\"] :runtime {:timeout \"10s\"} :next :done} :done {:type :terminal :status :success}}"
        )
        wf = write_workflow(tmp, states)
        run_dir = start(tmp, home, wf)
        step(run_dir, home)

        # Edit the workflow file so the pinned hash no longer matches.
        wf.write_text(wf.read_text() + "\n;; edited after pin\n")

        rejected = retry(run_dir, home)
        assert rejected.returncode != 0, rejected.stdout
        assert "retry_pin_mismatch" in rejected.stderr, rejected.stderr

        retried = retry(run_dir, home, reason="repin after fix", repin=True)
        assert retried.returncode == 0, retried.stderr
        finished = json.loads(retried.stdout)["run"]
        assert finished["status"] == "done", finished

        events = read_events(run_dir)
        recovery = [e for e in events if e.get("event") == "run.recovery"]
        assert len(recovery) == 1
        repin = recovery[0].get("repin")
        assert repin and repin.get("old_hash") and repin.get("new_hash")
        assert repin["old_hash"] != repin["new_hash"]

    with_tmp(run)


def test_retry_after_cancel():
    def run(tmp):
        home = tmp / "home"
        script = tmp / "hang.py"
        write_hang_then_succeed_script(script)
        states = (
            "{:boom {:type :process :title \"Hang\" :command [\"bash\" \"-lc\" \"python3 "
            + str(script).replace("\\", "\\\\")
            + "\"] :runtime {:timeout \"10s\"} :next :done} :done {:type :terminal :status :success}}"
        )
        wf = write_workflow(tmp, states)
        run_dir = start(tmp, home, wf)

        proc = tesseraft_bg(["run", "resume", "--run-dir", str(run_dir), "--format", "json"], home)
        hang_pid = None
        try:
            hang_pid = wait_for_pid(run_dir / "hang.pid")
            assert hang_pid is not None

            cancelled = tesseraft(["run", "cancel", "--run-dir", str(run_dir), "--format", "json"], home)
            assert cancelled.returncode == 0, cancelled.stderr
            proc.wait(timeout=10)
            proc = None

            assert ':status "cancelled"' in (run_dir / "state.edn").read_text()

            retried = retry(run_dir, home)
            assert retried.returncode == 0, retried.stderr
            finished = json.loads(retried.stdout)["run"]
            assert finished["status"] == "done", finished
            assert finished["attempt"] == 2, finished

            events = read_events(run_dir)
            assert any(e.get("event") == "run.cancelled" for e in events)
            recovery = [e for e in events if e.get("event") == "run.recovery"]
            assert len(recovery) == 1
            assert recovery[0]["prior_status"] == "cancelled"
        finally:
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            if hang_pid is not None:
                kill_pid_if_alive(hang_pid)

    with_tmp(run)


def test_retry_after_orphan_re_executes_cleanly():
    def run(tmp):
        home = tmp / "home"
        script = tmp / "hang.py"
        write_hang_then_succeed_script(script)
        states = (
            "{:boom {:type :process :title \"Hang\" :command [\"bash\" \"-lc\" \"python3 "
            + str(script).replace("\\", "\\\\")
            + "\"] :runtime {:timeout \"10s\"} :next :done} :done {:type :terminal :status :success}}"
        )
        wf = write_workflow(tmp, states)
        run_dir = start(tmp, home, wf)

        proc = tesseraft_bg(["run", "resume", "--run-dir", str(run_dir), "--format", "json"], home)
        hang_pid = None
        try:
            hang_pid = wait_for_pid(run_dir / "hang.pid")
            assert hang_pid is not None

            pid = runtime_process_pid(run_dir)
            os.kill(pid, signal.SIGKILL)
            proc.wait(timeout=10)
            proc = None

            # The run is still "running" in state.edn because the runtime process
            # was killed. Drive a resume to detect the orphan and mark it failed
            # before retry can reopen it.
            orphaned = resume(run_dir, home)
            assert orphaned.returncode != 0, orphaned.stdout
            assert ':status "failed"' in (run_dir / "state.edn").read_text()
            events = read_events(run_dir)
            assert any(e.get("event") == "node.orphaned" for e in events)

            retried = retry(run_dir, home)
            assert retried.returncode == 0, retried.stderr
            finished = json.loads(retried.stdout)["run"]
            assert finished["status"] == "done", finished
            assert finished["attempt"] == 2, finished

            events = read_events(run_dir)
            recovery = [e for e in events if e.get("event") == "run.recovery"]
            assert len(recovery) == 1
            assert recovery[0].get("prior_evidence", {}).get("event") == "node.orphaned"
        finally:
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            if hang_pid is not None:
                kill_pid_if_alive(hang_pid)

    with_tmp(run)


def test_retry_preserves_agent_artifact_recovery_precedence():
    def run(tmp):
        home = tmp / "home"
        stub = tmp / "pi-stub.sh"
        calls_file = tmp / "pi-calls.log"
        write_pi_stub(stub, fail_first=True)

        wf = write_workflow(
            tmp,
            "{:agent {:type :agent :executor :pi-cli :prompt-template \"agent.md.tmpl\" :runtime {:timeout \"10s\"} :outputs {:status {:path \"agent/status.json\" :required true}} :next :done} :done {:type :terminal :status :success}}",
            state_id="agent",
            name="retry-agent-fixture",
        )
        (tmp / "agent.md.tmpl").write_text("Agent prompt.\n")

        run_dir = start(tmp, home, wf)
        failed = step(run_dir, home, extra_env={"PI_BIN": str(stub), "PI_STUB_CALLS": str(calls_file)})
        assert failed.returncode != 0, failed.stdout
        assert ':status "failed"' in (run_dir / "state.edn").read_text()
        assert (run_dir / "agent" / "status.json").exists()

        # Stub should have been called exactly once.
        assert calls_file.read_text().splitlines() == ["call"], calls_file.read_text()

        retried = retry(run_dir, home, reason="retry after agent crash", extra_env={"PI_BIN": str(stub), "PI_STUB_CALLS": str(calls_file)})
        assert retried.returncode == 0, retried.stderr
        finished = json.loads(retried.stdout)["run"]
        assert finished["status"] == "done", finished

        # Stub should still have been called exactly once; the agent node was
        # recovered from its existing status artifact.
        assert calls_file.read_text().splitlines() == ["call"], calls_file.read_text()

        events = read_events(run_dir)
        assert any(e.get("event") == "node.recovered" for e in events)

    with_tmp(run)


def test_fragment_retry_creates_fresh_attempt():
    def run(tmp):
        home = tmp / "home"
        stage_fragment(tmp, "runtime-resume")
        wf = write_fragment_workflow(tmp, "runtime-resume")
        run_dir = start(tmp, home, wf)

        pi_stub = tmp / "pi-stub.sh"
        calls_file = tmp / "pi-calls.log"
        write_pi_stub(pi_stub, fail_first=True)
        extra_env = {"PI_BIN": str(pi_stub), "PI_STUB_CALLS": str(calls_file)}

        # Run the fragment once to completion (FAIL_FIRST unset -> succeeds).
        completed = resume(run_dir, home, extra_env=extra_env)
        assert completed.returncode == 0, completed.stderr
        assert json.loads(completed.stdout)["run"]["status"] == "done"

        # A retried run at the same run-dir is not possible because it is done,
        # so construct a new parent run that points to the same fragment.
        run_dir2 = start(tmp, home, wf, run_id="second-run")
        # First attempt fails.
        failed = resume(run_dir2, home, extra_env={**extra_env, "FAIL_FIRST": "yes"})
        assert failed.returncode != 0, failed.stdout

        # Retry creates a fresh nested run at attempt 2.
        retried = retry(run_dir2, home, extra_env=extra_env)
        assert retried.returncode == 0, retried.stderr
        finished = json.loads(retried.stdout)["run"]
        assert finished["status"] == "done", finished
        assert finished["attempt"] == 2, finished

        nested_dir2 = run_dir2 / "fragments" / "run-fragment" / "2"
        assert (nested_dir2 / "state.edn").exists()
        assert ':status "done"' in (nested_dir2 / "state.edn").read_text()

    with_tmp(run)


def stage_fragment(tmp, name):
    src = FIXTURES / name
    dest_dir = tmp / ".tesseraft" / "fragments" / name
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    shutil.copytree(src, dest_dir)
    return dest_dir / "fragment.edn"


def write_fragment_workflow(tmp, fragment_name):
    workflow = f"""{{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {{:name "retry-fragment-{fragment_name}"}}
 :initial :run-fragment
 :states
 {{:run-fragment
   {{:type :fragment
    :fragment "{fragment_name}"
    :transitions [{{:when {{:fragment/outcome "pass"}} :next :done}}]}}
  :done {{:type :terminal :status :success}}}}
}}
"""
    path = tmp / "workflow.edn"
    path.write_text(workflow)
    return path


if __name__ == "__main__":
    test_retry_after_process_failure_re_executes_and_appends_recovery_event()
    test_retry_refuses_running()
    test_retry_refuses_done()
    test_retry_refuses_live_process()
    test_retry_refuses_pin_mismatch_and_repin_proceeds()
    test_retry_after_cancel()
    test_retry_after_orphan_re_executes_cleanly()
    test_retry_preserves_agent_artifact_recovery_precedence()
    test_fragment_retry_creates_fresh_attempt()
    print("ok")
