import path from 'node:path';
import { expect, test } from './fixtures';

test('updates an open run inspection through EventSource after an external CLI step', async ({ page, isolatedRun }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto(isolatedRun.baseURL);
  await page.evaluate(() => {
    (window as typeof window & { __pw2Sentinel?: { createdAt: number } }).__pw2Sentinel = { createdAt: Date.now() };
  });
  const sentinel = await page.evaluate(() => (window as typeof window & { __pw2Sentinel?: { createdAt: number } }).__pw2Sentinel);
  const initialUrl = page.url();

  await page.getByRole('button', { name: /Runs: operate and inspect run status/ }).click();
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();

  const row = page.locator('tr.runs-table-row', { hasText: isolatedRun.runId });
  await expect(row).toContainText(isolatedRun.workflowName);
  await expect(row).toContainText('start');
  await expect.poll(async () => {
    const body = await isolatedRun.apiJson<{ run: { status: string; state: string } }>(`/api/runs/${encodeURIComponent(isolatedRun.runId)}`);
    return { status: body.run.status, state: body.run.state };
  }).toEqual({ status: 'running', state: 'start' });
  await row.click();

  const inspection = page.locator(`#run-inspection-${isolatedRun.runId}`);
  await expect(inspection).toBeVisible();
  await expect(inspection).toContainText('Status');
  await expect(inspection).toContainText('running');
  await expect(inspection).toContainText('State');
  await expect(inspection).toContainText('start');
  await expect(inspection).toContainText(/Streaming · (pending|\d)/);
  await expect(inspection).toContainText('Active, last refresh');
  await page.getByLabel('Show finished runs').check();

  await isolatedRun.runCli(['run', 'step', '--run-dir', isolatedRun.runDir, '--format', 'json']);
  await isolatedRun.runCli(['run', 'step', '--run-dir', isolatedRun.runDir, '--format', 'json']);

  await expect.poll(async () => {
    const body = await isolatedRun.apiJson<{ run: { status: string; state: string; path: string } }>(`/api/runs/${encodeURIComponent(isolatedRun.runId)}`);
    const apiRunDir = path.resolve(isolatedRun.workspaceRoot, body.run.path);
    return { status: body.run.status, state: body.run.state, path: apiRunDir };
  }).toMatchObject({ status: 'done', state: 'done', path: path.resolve(isolatedRun.runDir) });

  await expect(inspection).toContainText('done', { timeout: 15_000 });
  await expect(inspection).toContainText('Inactive', { timeout: 15_000 });
  await expect(row).toContainText('done', { timeout: 15_000 });

  expect(page.url()).toBe(initialUrl);
  await expect.poll(async () => page.evaluate(() => (window as typeof window & { __pw2Sentinel?: { createdAt: number } }).__pw2Sentinel)).toEqual(sentinel);
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
