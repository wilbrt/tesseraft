import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const waitFor = async (predicate: () => Promise<boolean>, timeout = 15_000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for focused approval lifecycle');
};

const readJson = async <T extends object>(target: string): Promise<T> => JSON.parse(await fs.readFile(target, 'utf8')) as T;
const applyOperation = (request: object, env: NodeJS.ProcessEnv): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(path.join(repoRoot, 'bin', 'tesseraft'), ['run', 'apply', '--input', '-'], {
    cwd: repoRoot, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`reconcile failed (${code}): ${stdout}\n${stderr}`)));
  child.stdin.end(JSON.stringify(request));
});
const kill = (pid: number): void => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
const live = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

const waitForLock = (child: ChildProcessWithoutNullStreams): Promise<void> => new Promise((resolve, reject) => {
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); if (stdout.includes('locked')) resolve(); });
  child.once('error', reject);
  child.once('exit', (code) => { if (!stdout.includes('locked')) reject(new Error(`lock holder exited before acquisition: ${code}`)); });
});

const workflow = (name: string): string => `{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "${name}"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :review
 :states {:review {:type :approval :message "Review focused changes" :timeout "1m"
                   :review-server {:kind :git-diff :max-diff-bytes 1048576}
                   :presentation {:question "Approve focused changes?"
                                  :decisions [{:decision "pass" :label "Pass"}
                                              {:decision "reject" :label "Reject" :requires-message true}]}
                   :transitions [{:when {:decision "pass"} :next :done}
                                  {:when {:decision "reject"} :effects [:merge-issues] :next :implement}]}
          :implement {:type :agent :executor :pi-cli
                      :prompt-template "prompt.md"
                      :prompt-output "prompts/generated/implement.md"
                      :runtime {:timeout "1m"}
                      :session {:mode :resumable
                                :continuation-prompt-template "continue.md"
                                :continuation-prompt-output "prompts/generated/continue-{{run.attempt}}.md"}
                      :outputs {:status {:path "execution/status-{{run.attempt}}.json" :required true}}
                      :next :done}
          :done {:type :terminal :status :success}}}`;

test('browser abort plus candidate and adapter SIGKILL converges through external drain reconciliation', async ({ page, isolatedWorkspace }) => {
  const name = isolatedWorkspace.uniqueName('focused-fault');
  const runId = `run-${name}`;
  const gitDir = path.join(isolatedWorkspace.tempRoot, 'repo');
  const workflowDir = isolatedWorkspace.workflowPackagePath(name);
  const workflowPath = path.join(workflowDir, 'workflow.edn');
  const commandEnv = { TESSERAFT_INSTALL_ROOT: repoRoot, TESSERAFT_TEST_ADAPTER_HOLD_AFTER_ABORT: 'true' };
  let runDir: string | undefined;
  let lockHolder: ChildProcessWithoutNullStreams | undefined;

  try {
    await fs.mkdir(gitDir, { recursive: true });
    await execFile('git', ['init', '-q'], { cwd: gitDir });
    await execFile('git', ['config', 'user.name', 'Focused Browser'], { cwd: gitDir });
    await execFile('git', ['config', 'user.email', 'browser@example.test'], { cwd: gitDir });
    await fs.writeFile(path.join(gitDir, 'review.txt'), 'before\n');
    await execFile('git', ['add', 'review.txt'], { cwd: gitDir });
    await execFile('git', ['commit', '-qm', 'base'], { cwd: gitDir });
    await fs.writeFile(path.join(gitDir, 'review.txt'), 'after\n');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(path.join(workflowDir, 'prompt.md'), 'Implement requested review feedback.');
    await fs.writeFile(path.join(workflowDir, 'continue.md'), 'Continue implementing requested review feedback.');
    await fs.writeFile(workflowPath, workflow(name));

    const started = await isolatedWorkspace.runCli([
      'run', 'start', workflowPath, '--run-id', runId,
      '--workspace-root', isolatedWorkspace.workspaceRoot,
      '--input', `repo-root=${gitDir}`, '--format', 'json'
    ], { env: commandEnv });
    runDir = (started.json as { run: { dir: string } }).run.dir;
    await isolatedWorkspace.runCli([
      'run', 'resume', '--run-dir', runDir, '--max-steps', '1', '--format', 'json'
    ], { env: commandEnv });

    const ownerPath = path.join(runDir, 'approval-adapters', 'review', '1', 'owner.json');
    const capabilityPath = path.join(runDir, 'approval-adapters', 'review', '1', 'capability.json');
    const drainDir = path.join(runDir, 'approval-adapters', 'review', '1', 'drains');
    await waitFor(async () => {
      try { return (await readJson<{ status: string }>(ownerPath)).status === 'ready' && Boolean(await fs.stat(capabilityPath)); }
      catch { return false; }
    });
    const owner = await readJson<{ pid: number; endpoint: string }>(ownerPath);
    const capability = await readJson<{ token: string; launch_url: string }>(capabilityPath);
    await page.goto(capability.launch_url);
    await expect(page.getByRole('heading', { name: 'Review current Git changes' })).toBeVisible();

    const expression = `(require '[tesseraft.runtime.store :as s]) (s/with-run-lock ${JSON.stringify(runDir)} #(do (println "locked") (flush) (Thread/sleep 1200)))`;
    lockHolder = spawn('bb', ['--classpath', path.join(repoRoot, 'src'), '-e', expression], {
      cwd: repoRoot, env: { ...process.env, AGENT_RUN_DIR: runDir }, stdio: ['pipe', 'pipe', 'pipe']
    });
    await waitForLock(lockHolder);

    const abortPage = await page.context().newPage();
    await abortPage.goto(capability.launch_url);
    await abortPage.evaluate(({ endpoint, token }) => {
      void fetch(`${endpoint}/api/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tesseraft-approval-token': token },
        body: JSON.stringify({ decision: 'invalid' })
      }).catch(() => {});
    }, { endpoint: owner.endpoint, token: capability.token });
    await waitFor(async () => {
      try { return Boolean((await readJson<{ decision_started_at?: string }>(ownerPath)).decision_started_at); }
      catch { return false; }
    });
    await abortPage.close();
    await waitFor(async () => {
      try { return (await readJson<{ transport_status?: string }>(ownerPath)).transport_status === 'aborted'; }
      catch { return false; }
    });
    await new Promise<void>((resolve) => lockHolder?.once('exit', () => resolve()));
    lockHolder = undefined;

    let receiptPath = '';
    await waitFor(async () => {
      try {
        const names = await fs.readdir(drainDir);
        receiptPath = path.join(drainDir, names[0] ?? '');
        return names.length === 1 && (await readJson<{ phase: string; drain_generation: number }>(receiptPath)).phase === 'claimed';
      } catch { return false; }
    });
    const generation1 = await readJson<{ worker_pid: number; drain_generation: number }>(receiptPath);
    expect(generation1.drain_generation).toBe(1);
    let standbyPid = 0;
    await waitFor(async () => {
      try {
        const drainingOwner = await readJson<{ supervisor_candidate_pids?: number[] }>(ownerPath);
        standbyPid = drainingOwner.supervisor_candidate_pids?.find((pid) => pid !== generation1.worker_pid) ?? 0;
        return standbyPid > 0 && live(standbyPid);
      } catch { return false; }
    });
    kill(generation1.worker_pid);
    kill(standbyPid);
    kill(owner.pid);
    await waitFor(async () => !live(generation1.worker_pid) && !live(standbyPid) && !live(owner.pid));

    try {
      await waitFor(async () => {
        try {
          await applyOperation({ operation: 'approval.adapter.reconcile', payload: { run_dir: runDir } }, commandEnv);
          const receipt = await readJson<{ drain_generation: number; lifecycle_status?: string }>(receiptPath);
          const replacement = await readJson<{ pid: number; status: string }>(ownerPath);
          return receipt.drain_generation === 2 && receipt.lifecycle_status === 'complete'
            && replacement.pid !== owner.pid && replacement.status === 'ready'
            && Boolean(await fs.stat(capabilityPath));
        } catch { return false; }
      }, 20_000);
    } catch (error) {
      const diagnostic = {
        receipt: await readJson<object>(receiptPath).catch((failure) => ({ read_error: String(failure) })),
        owner: await readJson<object>(ownerPath).catch((failure) => ({ read_error: String(failure) })),
        capability: await fs.stat(capabilityPath).then(() => true, () => false),
        standby_pid: standbyPid,
        standby_live: live(standbyPid),
        adapter_log: await fs.readFile(path.join(path.dirname(ownerPath), 'adapter.log'), 'utf8').catch((failure) => String(failure)),
        adapter_error: await fs.readFile(path.join(path.dirname(ownerPath), 'adapter-error.log'), 'utf8').catch((failure) => String(failure))
      };
      throw new Error(`${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`);
    }

    const receipt = await readJson<{ drain_generation: number; transport_status: string; lifecycle_status: string; listener_absent: boolean }>(receiptPath);
    expect(receipt).toMatchObject({ drain_generation: 2, transport_status: 'aborted', lifecycle_status: 'complete', listener_absent: true });
    const state = await fs.readFile(path.join(runDir, 'state.edn'), 'utf8');
    expect(state).toContain(':status "blocked"');
    await expect(page).toHaveURL(capability.launch_url);
  } finally {
    if (lockHolder && lockHolder.exitCode === null) kill(lockHolder.pid!);
    if (runDir) {
      try { await isolatedWorkspace.runCli(['run', 'cancel', '--run-dir', runDir, '--format', 'json'], { env: commandEnv }); }
      catch { /* fixture removal is the final fallback */ }
    }
  }
});
