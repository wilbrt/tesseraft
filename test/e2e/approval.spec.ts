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

  await page.getByRole('button', { name: /Approvals: review pending decisions/ }).click();
  const approvalInbox = page.locator('[aria-label="Approval inbox"]');
  await expect(approvalInbox).toBeVisible();
  await expect(approvalInbox).toContainText(isolatedApprovalRun.expectedBlockedState);
  await expect(approvalInbox).toContainText(isolatedApprovalRun.approvalId);
  await expect(approvalInbox).toContainText(isolatedApprovalRun.question);
  await expect(approvalInbox).toContainText(isolatedApprovalRun.artifactPath);
  await expect(approvalInbox).toContainText(isolatedApprovalRun.artifactKind);
  await expect(approvalInbox.getByRole('button', { name: /^Approve/ })).toBeVisible();
  await expect(approvalInbox.getByRole('button', { name: /^Request changes/ })).toBeVisible();

  const approvalsBefore = await isolatedApprovalRun.apiJson<{ approvals: Array<{ approval_id: string; question?: string; artifacts?: Array<{ path?: string; kind?: string }>; decisions?: Array<{ decision: string; next?: string }>; decision?: unknown }> }>(`/api/projects/default/runs/${encodeURIComponent(isolatedApprovalRun.runId)}/approvals`);
  const pending = approvalsBefore.approvals.find((approval) => approval.approval_id === isolatedApprovalRun.approvalId);
  expect(pending).toBeTruthy();
  expect(pending?.decision ?? null).toBeNull();
  expect(pending?.question).toBe(isolatedApprovalRun.question);
  expect(pending?.artifacts?.[0]).toMatchObject({ path: isolatedApprovalRun.artifactPath, kind: isolatedApprovalRun.artifactKind });
  expect(pending?.decisions?.map((decision) => decision.decision)).toEqual(isolatedApprovalRun.decisions);

  const addedLine = approvalInbox.locator('.approval-source-row.added .line-number');
  await expect(addedLine).toBeVisible();
  await addedLine.click();
  await approvalInbox.getByPlaceholder('Explain what should change at this line…').fill(isolatedApprovalRun.annotation);
  await approvalInbox.getByRole('button', { name: 'Add annotation' }).click();
  await expect(approvalInbox).toContainText(isolatedApprovalRun.annotation);
  await approvalInbox.getByLabel('Overall message').fill(isolatedApprovalRun.summary);
  await approvalInbox.getByRole('button', { name: /^Request changes/ }).click();

  await expect(approvalInbox.getByRole('heading', { name: 'You’re caught up' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Runs: operate and inspect run status/ }).click();
  await page.getByLabel('Show finished runs').check();

  await expect.poll(async () => {
    const body = await isolatedApprovalRun.apiJson<{ run: { status: string; state: string; path: string } }>(`/api/projects/default/runs/${encodeURIComponent(isolatedApprovalRun.runId)}`);
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

  const approvalAfter = await isolatedApprovalRun.apiJson<{ approval: { approval_id: string; decision?: { approval_id: string; decision: string; message?: string | null; summary?: string | null; annotations?: Array<{ artifact_path: string; body: string; anchor: { side?: string; line?: number } }> } | null } }>(`/api/projects/default/runs/${encodeURIComponent(isolatedApprovalRun.runId)}/approval/${encodeURIComponent(isolatedApprovalRun.approvalId)}`);
  expect(approvalAfter.approval.decision).toMatchObject({
    approval_id: isolatedApprovalRun.approvalId,
    decision: isolatedApprovalRun.expectedDecision,
    message: isolatedApprovalRun.summary,
    annotations: [{ artifact_path: isolatedApprovalRun.artifactPath, body: isolatedApprovalRun.annotation, anchor: { side: 'new', line: 1 } }]
  });

  const decisionPath = path.join(isolatedApprovalRun.runDir, 'approvals', `${isolatedApprovalRun.approvalId}-decision.json`);
  expect(path.resolve(decisionPath).startsWith(path.resolve(isolatedApprovalRun.workspaceRoot) + path.sep)).toBeTruthy();
  const decisionRecord = JSON.parse(await fs.readFile(decisionPath, 'utf8')) as { approval_id: string; decision: string; message?: string | null; annotations?: Array<{ artifact_path: string; body: string }> };
  expect(decisionRecord).toMatchObject({
    approval_id: isolatedApprovalRun.approvalId,
    decision: isolatedApprovalRun.expectedDecision,
    message: isolatedApprovalRun.summary,
    annotations: [{ artifact_path: isolatedApprovalRun.artifactPath, body: isolatedApprovalRun.annotation }]
  });

  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
