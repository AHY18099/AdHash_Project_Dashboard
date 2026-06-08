import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['list'],
    ['./utils/UnifiedHtmlReporter.ts']
  ],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30000,
    navigationTimeout: 60000,
  },
  timeout: 120000,
  expect: {
    timeout: 10000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // Exclude app-status tests — they use HTTP checks and don't need a browser
      testIgnore: ['**/app-status/**'],
    },
    {
      // Browser-less project for app store HTTP checks
      name: 'app-status',
      testMatch: ['**/app-status/**'],
      use: {},
    },
  ],
  outputDir: 'test-results/',
});

