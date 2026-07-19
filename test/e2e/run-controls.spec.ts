import path from 'node:path';
import { expect, test } from './fixtures';

test('starts, steps, and resumes a safe local workflow from visible run controls', async ({ page, isolatedRun }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto(isolatedRun.baseURL);
  await page.getByRole('button', { name: /Runs: operate and inspect run status/ }).click();
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();

  await page.getByLabel('Run controls').getByRole('button', { name: 'Start workflow', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: 'Start workflow' });
  await expect(wizard).toBeVisible();
  await wizard.getByRole('button', { name: isolatedRun.pw3.workflowName, exact: true }).click();
  await expect(wizard.getByRole('heading', { name: 'PW3 Run Controls' })).toBeVisible();
  await wizard.getByLabel('Run ID').fill(isolatedRun.pw3.runId);
  await wizard.getByLabel('Max automated steps').fill('1');
  await wizard.getByLabel('I understand this may execute local side effects automatically.').check();
  await wizard.getByRole('button', { name: 'Start and run' }).click();
  await expect(wizard).toBeHidden();

  await expect.poll(async () => {
    const body = await isolatedRun.apiJson<{ run: { status: string; state: string; path: string } }>(`/api/runs/${encodeURIComponent(isolatedRun.pw3.runId)}`);
    const apiRunDir = path.resolve(isolatedRun.workspaceRoot, body.run.path);
    return { status: body.run.status, state: body.run.state, pathUnderWorkspace: apiRunDir.startsWith(path.resolve(isolatedRun.workspaceRoot) + path.sep) };
  }, { timeout: 15_000 }).toEqual({ status: 'running', state: isolatedRun.pw3.expectedAfterStartState, pathUnderWorkspace: true });

  const row = page.locator('tr.runs-table-row', { hasText: isolatedRun.pw3.runId });
  await expect(row).toContainText(isolatedRun.pw3.workflowName);
  await expect(row).toContainText(isolatedRun.pw3.expectedAfterStartState);
  await expect(row).toHaveAttribute('aria-current', 'true');

  const inspection = page.locator(`#run-inspection-${isolatedRun.pw3.runId}`);
  await expect(inspection).toBeVisible();
  await expect(inspection).toContainText('Status');
  await expect(inspection).toContainText('running');
  await expect(inspection).toContainText('State');
  await expect(inspection).toContainText(isolatedRun.pw3.expectedAfterStartState);

  await page.getByLabel('Confirm one local node execution.').check();
  await page.getByRole('button', { name: 'Step one node' }).click();

  await expect.poll(async () => {
    const body = await isolatedRun.apiJson<{ run: { status: string; state: string } }>(`/api/runs/${encodeURIComponent(isolatedRun.pw3.runId)}`);
    return { status: body.run.status, state: body.run.state };
  }, { timeout: 15_000 }).toEqual({ status: 'running', state: isolatedRun.pw3.expectedAfterStepState });
  await expect(row).toContainText(isolatedRun.pw3.expectedAfterStepState, { timeout: 15_000 });
  await expect(inspection).toContainText(isolatedRun.pw3.expectedAfterStepState, { timeout: 15_000 });

  await page.getByLabel('Show finished runs').check();
  await page.getByLabel('Confirm bounded local execution.').check();
  await page.getByRole('button', { name: 'Resume run' }).click();

  await expect.poll(async () => {
    const body = await isolatedRun.apiJson<{ run: { status: string; state: string; path: string } }>(`/api/runs/${encodeURIComponent(isolatedRun.pw3.runId)}`);
    const apiRunDir = path.resolve(isolatedRun.workspaceRoot, body.run.path);
    return { status: body.run.status, state: body.run.state, pathUnderWorkspace: apiRunDir.startsWith(path.resolve(isolatedRun.workspaceRoot) + path.sep) };
  }, { timeout: 15_000 }).toEqual({ status: 'done', state: 'done', pathUnderWorkspace: true });

  await expect(row).toContainText('done', { timeout: 15_000 });
  await expect(inspection).toContainText('done', { timeout: 15_000 });
  await expect(inspection).toContainText('Inactive', { timeout: 15_000 });
  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
