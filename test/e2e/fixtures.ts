import { test as base, expect } from '@playwright/test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const tesseraftBin = path.join(repoRoot, 'bin', 'tesseraft');
const serverEntry = path.join(repoRoot, 'web', 'dist-server', 'server.js');

type CliResult = { stdout: string; stderr: string; json: unknown };

type Pw3RunControlScenario = {
  workflowName: string;
  workflowPath: string;
  runId: string;
  expectedAfterStartState: string;
  expectedAfterStepState: string;
};

type IsolatedWorkspaceFixture = {
  baseURL: string;
  workspaceRoot: string;
  tesseraftHome: string;
  tempRoot: string;
  uniqueName: (prefix: string) => string;
  workflowPackagePath: (name: string) => string;
  runCli: (args: string[], options?: { timeout?: number }) => Promise<CliResult>;
  apiJson: <T = unknown>(path: string) => Promise<T>;
};

type IsolatedRunFixture = IsolatedWorkspaceFixture & {
  workflowName: string;
  workflowPath: string;
  runId: string;
  runDir: string;
  pw3: Pw3RunControlScenario;
};

type WorkerFixtures = {
  isolatedWorkspace: IsolatedWorkspaceFixture;
  isolatedRun: IsolatedRunFixture;
};

const workflowEdn = (name: string): string => `{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "${name}" :title "PW2 Run Streaming"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :start
 :states {:start {:type :deterministic
                  :title "Start"
                  :handler :noop/succeed
                  :runtime {:timeout "10s"}
                  :next :done}
          :done {:type :terminal :title "Done" :status :success}}}
`;

const pw3WorkflowEdn = (name: string): string => `{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "${name}" :title "PW3 Run Controls"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :start
 :states {:start {:type :deterministic
                  :title "Start"
                  :handler :noop/succeed
                  :runtime {:timeout "10s"}
                  :next :after-start}
          :after-start {:type :deterministic
                        :title "After start"
                        :handler :noop/succeed
                        :runtime {:timeout "10s"}
                        :next :after-step}
          :after-step {:type :deterministic
                       :title "After step"
                       :handler :noop/succeed
                       :runtime {:timeout "10s"}
                       :next :done}
          :done {:type :terminal :title "Done" :status :success}}}
`;

const waitForServer = async (child: ChildProcessWithoutNullStreams): Promise<string> => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`));
  }, 30_000);
  const finish = (url: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve(url);
  };
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    reject(error);
  };
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) finish(`http://127.0.0.1:${match[1]}`);
  });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.once('error', fail);
  child.once('exit', (code) => fail(new Error(`server exited before readiness with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`)));
});

const terminate = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3000).unref())
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
};

const expectUnder = (parent: string, child: string): void => {
  const rel = path.relative(parent, child);
  expect(rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))).toBeTruthy();
};

export const test = base.extend<{}, WorkerFixtures>({
  isolatedWorkspace: [async ({}, use) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tesseraft-pw-'));
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const tesseraftHome = path.join(tempRoot, 'home');
    let child: ChildProcessWithoutNullStreams | null = null;

    const env = { ...process.env, TESSERAFT_WORKSPACE_ROOT: workspaceRoot, TESSERAFT_HOME: tesseraftHome };
    const runCli = (args: string[], options: { timeout?: number } = {}): Promise<CliResult> => new Promise((resolve, reject) => {
      execFile(tesseraftBin, args, { cwd: workspaceRoot, env, timeout: options.timeout ?? 20_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`tesseraft ${args.join(' ')} failed: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
          return;
        }
        let json: unknown = null;
        if (stdout.trim()) {
          try { json = JSON.parse(stdout); } catch (parseError) { reject(parseError); return; }
        }
        resolve({ stdout, stderr, json });
      });
    });

    try {
      await fs.mkdir(workspaceRoot, { recursive: true });
      await fs.mkdir(tesseraftHome, { recursive: true });
      child = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', '0'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const baseURL = await waitForServer(child);
      const ready = await fetch(baseURL);
      expect(ready.status).toBe(200);

      const apiJson = async <T = unknown>(apiPath: string): Promise<T> => {
        const response = await fetch(`${baseURL}${apiPath}`);
        expect(response.status, `${apiPath} status`).toBe(200);
        return await response.json() as T;
      };
      const uniqueName = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      const workflowPackagePath = (name: string): string => path.join(workspaceRoot, '.tesseraft', 'workflows', name);

      await use({ baseURL, workspaceRoot, tesseraftHome, tempRoot, uniqueName, workflowPackagePath, runCli, apiJson });
    } finally {
      if (child) await terminate(child);
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],

  isolatedRun: [async ({ isolatedWorkspace }, use) => {
    const workflowName = isolatedWorkspace.uniqueName('pw2');
    const runId = `run-${workflowName.replace(/^pw2-/, '')}`;
    const workflowDir = isolatedWorkspace.workflowPackagePath(workflowName);
    const workflowPath = path.join(workflowDir, 'workflow.edn');
    const pw3WorkflowName = isolatedWorkspace.uniqueName('pw3');
    const pw3WorkflowPath = path.join(isolatedWorkspace.workflowPackagePath(pw3WorkflowName), 'workflow.edn');
    const pw3RunId = `pw3-${pw3WorkflowName.replace(/^pw3-/, '')}`;

    await fs.mkdir(workflowDir, { recursive: true });
    await fs.mkdir(path.dirname(pw3WorkflowPath), { recursive: true });
    await fs.writeFile(workflowPath, workflowEdn(workflowName));
    await fs.writeFile(pw3WorkflowPath, pw3WorkflowEdn(pw3WorkflowName));

    const started = await isolatedWorkspace.runCli(['run', 'start', workflowPath, '--run-id', runId, '--format', 'json']);
    const body = started.json as { run?: { dir?: string } };
    const runDir = body.run?.dir || path.join(isolatedWorkspace.workspaceRoot, '.agent-runs', workflowName, runId);
    expectUnder(isolatedWorkspace.workspaceRoot, runDir);
    expectUnder(isolatedWorkspace.workspaceRoot, workflowPath);
    expectUnder(isolatedWorkspace.workspaceRoot, pw3WorkflowPath);

    await use({
      ...isolatedWorkspace,
      workflowName,
      workflowPath,
      runId,
      runDir,
      pw3: {
        workflowName: pw3WorkflowName,
        workflowPath: pw3WorkflowPath,
        runId: pw3RunId,
        expectedAfterStartState: 'after-start',
        expectedAfterStepState: 'after-step'
      }
    });
  }, { scope: 'worker' }]
});

export { expect } from '@playwright/test';
