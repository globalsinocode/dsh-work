import { defineConfig, devices } from '@playwright/test'

const adminPort = process.env.DSH_WORK_SKILL_REVIEW_WEB_PORT ?? '4384'
const serverPort = process.env.DSH_WORK_SKILL_REVIEW_SERVER_PORT ?? '4394'
const baseURL = `http://localhost:${adminPort}`
const environment = {
  ...process.env,
  DSH_WORK_SKILL_REVIEW_SERVER_PORT: serverPort,
  DSH_WORK_SERVER_PORT: serverPort,
  DSH_WORK_ADMIN_PORT: adminPort,
}

export default defineConfig({
  testDir: './e2e',
  testMatch: 'skill-submission-review.integration.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: [
    {
      command: 'node --env-file-if-exists=.env --experimental-strip-types scripts/testing/skill-submission-review-browser.ts',
      url: `http://127.0.0.1:${serverPort}/health`,
      env: environment,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1',
      cwd: 'apps/admin-web',
      url: `${baseURL}/skills/review`,
      env: environment,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
