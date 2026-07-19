import { expect, test, type Locator, type Page } from '@playwright/test';

type ViewportCase = {
  name: string;
  width: number;
  height: number;
};

const VIEWPORTS: ViewportCase[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
];

const expectDocumentFitsHorizontally = async (page: Page): Promise<void> => {
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
};

const getRect = async (locator: Locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width
  };
});

test.describe('responsive geometry', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} viewport keeps shell, project selector, and Settings within usable width`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
      await expectDocumentFitsHorizontally(page);

      const projectButton = page.getByRole('button', { name: /Project/ });
      await expect(projectButton).toBeVisible();
      await projectButton.click();
      await expect(projectButton).toHaveAttribute('aria-expanded', 'true');

      const popover = page.getByTestId('project-selector-popover');
      const menu = page.getByTestId('project-selector-menu');
      await expect(popover).toBeVisible();
      await expect(menu).toBeVisible();

      await expect.poll(async () => popover.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(centerX, centerY);
        const clippingAncestors: Array<{ tagName: string; className: string; overflow: string; intersects: boolean }> = [];
        let ancestor = element.parentElement;
        while (ancestor) {
          const style = getComputedStyle(ancestor);
          const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
          if (/(auto|hidden|clip|scroll)/.test(overflow)) {
            const ancestorRect = ancestor.getBoundingClientRect();
            clippingAncestors.push({
              tagName: ancestor.tagName,
              className: ancestor.className.toString(),
              overflow,
              intersects: ancestorRect.left > rect.left || ancestorRect.top > rect.top || ancestorRect.right < rect.right || ancestorRect.bottom < rect.bottom
            });
          }
          ancestor = ancestor.parentElement;
        }
        return {
          clippedByAncestor: clippingAncestors.some((item) => item.intersects),
          height: rect.height,
          hitTarget: Boolean(hit && element.contains(hit)),
          parentIsBody: element.parentElement === document.body,
          width: rect.width,
          withinViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
        };
      })).toEqual({
        clippedByAncestor: false,
        height: expect.any(Number),
        hitTarget: true,
        parentIsBody: true,
        width: expect.any(Number),
        withinViewport: true
      });

      const popoverRect = await getRect(popover);
      expect(popoverRect.width).toBeGreaterThan(0);
      expect(popoverRect.height).toBeGreaterThan(0);
      expect(popoverRect.left).toBeGreaterThanOrEqual(0);
      expect(popoverRect.top).toBeGreaterThanOrEqual(0);
      expect(popoverRect.right).toBeLessThanOrEqual(viewport.width);
      expect(popoverRect.bottom).toBeLessThanOrEqual(viewport.height);
      await expectDocumentFitsHorizontally(page);

      await page.keyboard.press('Escape');
      await expect(projectButton).toHaveAttribute('aria-expanded', 'false');
      await expect(popover).toBeHidden();

      await page.getByRole('button', { name: /Settings: configure Pi defaults/ }).click();
      const settings = page.getByRole('region', { name: 'Settings' });
      await expect(settings).toBeVisible();
      await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible();
      await expectDocumentFitsHorizontally(page);

      await expect.poll(async () => settings.evaluate((element) => {
        const panelRect = element.getBoundingClientRect();
        const main = element.closest('main');
        if (!main) throw new Error('Settings panel is not inside main');
        const style = getComputedStyle(main);
        const contentWidth = main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return {
          contentWidth,
          fillsMainContent: Math.abs(panelRect.width - contentWidth) <= 1,
          height: panelRect.height,
          left: panelRect.left,
          right: panelRect.right,
          width: panelRect.width,
          withinViewport: panelRect.left >= 0 && panelRect.right <= window.innerWidth
        };
      })).toEqual({
        contentWidth: expect.any(Number),
        fillsMainContent: true,
        height: expect.any(Number),
        left: expect.any(Number),
        right: expect.any(Number),
        width: expect.any(Number),
        withinViewport: true
      });

      const settingsRect = await getRect(settings);
      expect(settingsRect.width).toBeGreaterThan(0);
      expect(settingsRect.left).toBeGreaterThanOrEqual(0);
      expect(settingsRect.right).toBeLessThanOrEqual(viewport.width);
    });
  }
});
