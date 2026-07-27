import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const repoKey = path.resolve(process.cwd());
const repoPortOffset = Array.from(repoKey).reduce((hash, char) => ((hash * 31) + char.charCodeAt(0)) % 20_000, 0);
const configuredPort = process.env.TESSERAFT_PLAYWRIGHT_PORT ? Number.parseInt(process.env.TESSERAFT_PLAYWRIGHT_PORT, 10) : NaN;
const TEST_PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535 ? configuredPort : 20_000 + repoPortOffset;

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${TEST_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: `npm run web:build && node web/dist-server/server.js --host 127.0.0.1 --port ${TEST_PORT}`,
    url: `http://127.0.0.1:${TEST_PORT}`,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
