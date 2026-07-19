import { expect, test } from '@playwright/test';

test('inspects the smoke-demo workflow graph without page errors', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();

  await page.getByRole('button', { name: 'smoke-demo', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Workflow detail' })).toBeVisible();
  await expect(page.getByText('Name')).toBeVisible();
  await expect(page.getByText('smoke-demo').first()).toBeVisible();

  const graph = page.getByTestId('workflow-graph');
  await expect(graph).toBeVisible();
  await expect(graph.getByRole('button', { name: 'Open node start details' })).toBeVisible();
  await expect(graph.getByRole('button', { name: 'Open node done details' })).toBeVisible();

  expect(pageErrors.map((error) => error.message)).toEqual([]);
});
