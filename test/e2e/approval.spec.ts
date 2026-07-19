import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';

test('submits one allowed approval decision and verifies durable runtime state', async ({ page, isolatedApprovalRun }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto(isolatedApprovalRun.baseURL);
  await page.getByRole('button', { name: /Runs: operate and inspect run status/ }).click();
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();

  const row = page.locator('tr.runs-table-row', { hasText: isolatedApprovalRun.runId });
  await expect(row).toContainText(isolatedApprovalRun.workflowName);
  await expect(row).toContainText(isolatedApprovalRun.expectedBlockedState);
  await expect(row).toContainText('parked');
  await row.click();

  const inspection = page.locator(`#run-inspection-${isolatedApprovalRun.runId}`);
  await expect(inspection).toBeVisible();
  await expect(inspection).toContainText('Status');
  await expect(inspection).toContainText('blocked');
  await expect(inspection).toContainText('State');
  await expect(inspection).toContainText(isolatedApprovalRun.expectedBlockedState);

  const approvalPanel = page.getByRole('region', { name: 'Approval decision' });
  await expect(approvalPanel).toBeVisible();
  await expect(approvalPanel).toContainText(isolatedApprovalRun.expectedBlockedState);
  await expect(approvalPanel).toContainText(isolatedApprovalRun.approvalId);
  await expect(approvalPanel).toContainText(isolatedApprovalRun.question);
  await expect(approvalPanel).toContainText(isolatedApprovalRun.artifactPath);
  await expect(approvalPanel).toContainText(isolatedApprovalRun.artifactKind);
  for (const decision of isolatedApprovalRun.decisions) {
    await expect(approvalPanel.getByRole('button', { name: decision, exact: true })).toBeVisible();
  }

  const approvalsBefore = await isolatedApprovalRun.apiJson<{ approvals: Array<{ approval_id: string; question?: string; artifacts?: Array<{ path?: string; kind?: string }>; decisions?: Array<{ decision: string; next?: string }>; decision?: unknown }> }>(`/api/runs/${encodeURIComponent(isolatedApprovalRun.runId)}/approvals`);
  const pending = approvalsBefore.approvals.find((approval) => approval.approval_id === isolatedApprovalRun.approvalId);
  expect(pending).toBeTruthy();
  expect(pending?.decision ?? null).toBeNull();
  expect(pending?.question).toBe(isolatedApprovalRun.question);
  expect(pending?.artifacts?.[0]).toMatchObject({ path: isolatedApprovalRun.artifactPath, kind: isolatedApprovalRun.artifactKind });
  expect(pending?.decisions?.map((decision) => decision.decision)).toEqual(isolatedApprovalRun.decisions);

  await approvalPanel.getByLabel('Summary (optional)').fill(isolatedApprovalRun.summary);
  await approvalPanel.getByRole('button', { name: isolatedApprovalRun.expectedDecision, exact: true }).click();

  await expect(approvalPanel).toBeHidden({ timeout: 15_000 });
  await page.getByLabel('Show finished runs').check();

  await expect.poll(async () => {
    const body = await isolatedApprovalRun.apiJson<{ run: { status: string; state: string; path: string } }>(`/api/runs/${encodeURIComponent(isolatedApprovalRun.runId)}`);
    const apiRunDir = path.resolve(isolatedApprovalRun.workspaceRoot, body.run.path);
    return {
      status: body.run.status,
      state: body.run.state,
      pathUnderWorkspace: apiRunDir.startsWith(path.resolve(isolatedApprovalRun.workspaceRoot) + path.sep)
    };
  }, { timeout: 15_000 }).toEqual({ status: 'done', state: isolatedApprovalRun.expectedTerminalState, pathUnderWorkspace: true });

  await expect(row).toContainText(isolatedApprovalRun.expectedTerminalState, { timeout: 15_000 });
  await expect(row).toContainText('done', { timeout: 15_000 });
  await expect(inspection).toContainText(isolatedApprovalRun.expectedTerminalState, { timeout: 15_000 });
  await expect(inspection).toContainText('Inactive', { timeout: 15_000 });

  const approvalAfter = await isolatedApprovalRun.apiJson<{ approval: { approval_id: string; decision?: { approval_id: string; decision: string; summary?: string | null } | null } }>(`/api/runs/${encodeURIComponent(isolatedApprovalRun.runId)}/approval/${encodeURIComponent(isolatedApprovalRun.approvalId)}`);
  expect(approvalAfter.approval.decision).toMatchObject({
    approval_id: isolatedApprovalRun.approvalId,
    decision: isolatedApprovalRun.expectedDecision,
    summary: isolatedApprovalRun.summary
  });

  const decisionPath = path.join(isolatedApprovalRun.runDir, 'approvals', `${isolatedApprovalRun.approvalId}-decision.json`);
  expect(path.resolve(decisionPath).startsWith(path.resolve(isolatedApprovalRun.workspaceRoot) + path.sep)).toBeTruthy();
  const decisionRecord = JSON.parse(await fs.readFile(decisionPath, 'utf8')) as { approval_id: string; decision: string; summary?: string | null };
  expect(decisionRecord).toMatchObject({
    approval_id: isolatedApprovalRun.approvalId,
    decision: isolatedApprovalRun.expectedDecision,
    summary: isolatedApprovalRun.summary
  });

  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
