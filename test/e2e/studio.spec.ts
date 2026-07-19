import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';

type LintItem = { code?: string; message?: string; severity?: string; path?: string[] };
type SaveResponse = {
  ok: boolean;
  save_mode: 'draft' | 'completed';
  lint?: { ok: boolean; errors?: LintItem[]; warnings?: LintItem[]; diagnostics?: LintItem[] };
};
type StudioGetResponse = {
  workflow: { edn: string; path: string };
  state: { status: string; draft?: { initial: string | null; states: Record<string, { type?: string; status?: string }> } };
};

const expectUnder = (parent: string, child: string): void => {
  const rel = path.relative(parent, child);
  expect(rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))).toBeTruthy();
};

const firstLintItem = (body: SaveResponse): LintItem => {
  const items = [...(body.lint?.errors || []), ...(body.lint?.warnings || []), ...(body.lint?.diagnostics || [])];
  const item = items.find((candidate) => candidate.code && candidate.message) || items.find((candidate) => candidate.message) || items[0];
  expect(item, 'server returned at least one lint diagnostic').toBeTruthy();
  return item;
};

test('saves Studio drafts while completed saves are visibly lint-gated', async ({ page, isolatedWorkspace }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  const workflowName = isolatedWorkspace.uniqueName('pw5');
  const packageDir = isolatedWorkspace.workflowPackagePath(workflowName);
  expectUnder(isolatedWorkspace.workspaceRoot, packageDir);

  await page.goto(isolatedWorkspace.baseURL);
  await page.getByRole('button', { name: /Workflow Studio: author workflows on a canvas/ }).click();
  await expect(page.getByRole('heading', { name: 'Workflow Studio' })).toBeVisible();

  await page.getByRole('button', { name: 'Create workflow' }).click();
  const createDialog = page.getByRole('dialog', { name: 'Create workflow' });
  await createDialog.getByLabel('Name (lowercase, hyphens)').fill(workflowName);
  const createResponse = page.waitForResponse((response) => response.url().endsWith('/api/studio/workflows') && response.request().method() === 'POST');
  await createDialog.getByRole('button', { name: 'Create', exact: true }).click();
  expect((await createResponse).status()).toBe(201);
  await expect(page.getByRole('heading', { name: `Workflow Studio — ${workflowName}` })).toBeVisible();

  const draftResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/studio/workflows/${workflowName}`) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save draft' }).click();
  const draftResponse = await draftResponsePromise;
  expect(draftResponse.status()).toBe(200);
  const draftBody = await draftResponse.json() as SaveResponse;
  expect(draftBody).toMatchObject({ ok: true, save_mode: 'draft' });
  await expect(page.getByText('Saved draft.')).toBeVisible();

  const invalidResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/studio/workflows/${workflowName}`) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save completed' }).click();
  const invalidResponse = await invalidResponsePromise;
  expect(invalidResponse.status()).toBe(422);
  const invalidBody = await invalidResponse.json() as SaveResponse;
  expect(invalidBody.ok).toBe(false);
  expect(invalidBody.save_mode).toBe('completed');
  expect(invalidBody.lint?.ok).toBe(false);
  const diagnostic = firstLintItem(invalidBody);
  await expect(page.getByText('Save completed blocked by linter. See issues below.')).toBeVisible();
  if (diagnostic.code) await expect(page.getByText(diagnostic.code)).toBeVisible();
  if (diagnostic.message) await expect(page.getByText(diagnostic.message, { exact: false })).toBeVisible();

  const sidecarAfterInvalid = JSON.parse(await fs.readFile(path.join(packageDir, 'studio-state.json'), 'utf8')) as { status: string };
  expect(sidecarAfterInvalid.status).toBe('draft');

  await page.getByRole('button', { name: 'Add node' }).click();
  const addNodeDialog = page.getByRole('dialog', { name: 'Add node' });
  await addNodeDialog.getByLabel('Node type').selectOption(':terminal');
  await addNodeDialog.getByLabel('ID (state keyword)').fill('start');
  await expect(addNodeDialog.getByLabel('Status', { exact: true })).toHaveValue(':success');
  await addNodeDialog.getByRole('button', { name: 'Save node' }).click();
  await expect(page.getByRole('button', { name: 'Node start' })).toBeVisible();

  const completedResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/studio/workflows/${workflowName}`) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save completed' }).click();
  const completedResponse = await completedResponsePromise;
  expect(completedResponse.status()).toBe(200);
  const completedBody = await completedResponse.json() as SaveResponse;
  expect(completedBody).toMatchObject({ ok: true, save_mode: 'completed' });
  expect(completedBody.lint?.ok).toBe(true);
  await expect(page.getByText('Saved completed (lint passed).')).toBeVisible();

  const loaded = await isolatedWorkspace.apiJson<StudioGetResponse>(`/api/studio/workflows/${encodeURIComponent(workflowName)}`);
  expect(loaded.state.status).toBe('completed');
  expect(loaded.state.draft?.initial).toBe('start');
  expect(loaded.state.draft?.states.start).toMatchObject({ type: ':terminal', status: ':success' });

  const workflowFile = path.join(packageDir, 'workflow.edn');
  expectUnder(isolatedWorkspace.workspaceRoot, workflowFile);
  const edn = await fs.readFile(workflowFile, 'utf8');
  expect(edn).toContain(':initial :start');
  expect(edn).toContain(':start');
  expect(edn).toContain(':terminal');
  expect(edn).toContain(':status :success');

  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
