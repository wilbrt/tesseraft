import fs from 'node:fs/promises';
import { expect, test } from './fixtures';

const runApiStatus = async (baseURL: string, runId: string): Promise<number> => {
  const response = await fetch(`${baseURL}/api/runs/${encodeURIComponent(runId)}`);
  return response.status;
};

test('visibly refuses deleting an executing run and deletes a terminal run', async ({ page, isolatedRun }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto(isolatedRun.baseURL);
  await page.getByRole('button', { name: /Runs: operate and inspect run status/ }).click();
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();

  await expect.poll(async () => {
    const body = await isolatedRun.apiJson<{ run: { liveness: string; status: string; state: string } }>(`/api/runs/${encodeURIComponent(isolatedRun.pw4.executingRunId)}`);
    return { liveness: body.run.liveness, status: body.run.status, state: body.run.state };
  }).toEqual({ liveness: 'executing', status: 'running', state: 'work' });

  const executingRow = page.locator('tr.runs-table-row', { hasText: isolatedRun.pw4.executingRunId });
  await expect(executingRow).toContainText(isolatedRun.pw4.workflowName);
  await executingRow.click();
  const executingInspection = page.locator(`#run-inspection-${isolatedRun.pw4.executingRunId}`);
  await expect(executingInspection).toBeVisible();
  await expect(executingInspection).toContainText('executing');

  await page.getByLabel("Confirm permanent deletion of this run's directory.").check();
  const executingDelete = page.waitForResponse((response) =>
    response.url().includes(`/api/runs/${encodeURIComponent(isolatedRun.pw4.executingRunId)}`) &&
    response.request().method() === 'DELETE'
  );
  await page.getByRole('button', { name: 'Delete run' }).click();
  expect((await executingDelete).status()).toBe(409);

  await expect(page.getByText('Run is still executing')).toBeVisible();
  await expect(executingRow).toBeVisible();
  await expect(executingInspection).toContainText('running');
  await expect.poll(async () => runApiStatus(isolatedRun.baseURL, isolatedRun.pw4.executingRunId)).toBe(200);
  await expect.poll(async () => fs.access(isolatedRun.pw4.executingRunDir).then(() => true, () => false)).toBe(true);

  await page.getByLabel('Show finished runs').check();
  const terminalRow = page.locator('tr.runs-table-row', { hasText: isolatedRun.pw4.terminalRunId });
  await expect(terminalRow).toContainText(isolatedRun.pw4.workflowName);
  await terminalRow.click();
  const terminalInspection = page.locator(`#run-inspection-${isolatedRun.pw4.terminalRunId}`);
  await expect(terminalInspection).toBeVisible();
  await expect(terminalInspection).toContainText('done');

  await page.getByLabel("Confirm permanent deletion of this run's directory.").check();
  const terminalDelete = page.waitForResponse((response) =>
    response.url().includes(`/api/runs/${encodeURIComponent(isolatedRun.pw4.terminalRunId)}`) &&
    response.request().method() === 'DELETE'
  );
  await page.getByRole('button', { name: 'Delete run' }).click();
  expect((await terminalDelete).status()).toBe(200);

  await expect(page.getByText('Mutation delete ok')).toBeVisible();
  await expect(terminalRow).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => runApiStatus(isolatedRun.baseURL, isolatedRun.pw4.terminalRunId), { timeout: 15_000 }).toBe(404);
  await expect.poll(async () => fs.access(isolatedRun.pw4.terminalRunDir).then(() => true, () => false), { timeout: 15_000 }).toBe(false);

  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
