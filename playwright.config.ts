import { defineConfig, devices } from '@playwright/test';

const TEST_PORT = 7342;

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
