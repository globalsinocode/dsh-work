import { defineConfig, devices } from '@playwright/test'

const port = process.env.DSH_WORK_AUTOMATION_WEB_PORT ?? '4375'
const serverPort = process.env.DSH_WORK_AUTOMATION_SERVER_PORT ?? '4391'
const baseURL = `http://localhost:${port}`
const environment = {
  ...process.env,
  DSH_WORK_AUTOMATION_SERVER_PORT: serverPort,
  DSH_WORK_SERVER_PORT: serverPort,
  DSH_WORK_WORKBENCH_PORT: port,
}

export default defineConfig({
  testDir: './e2e',
  testMatch: 'automation.integration.spec.ts',
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
      command: 'node --env-file-if-exists=.env --experimental-strip-types scripts/testing/automation-workbench-browser.ts',
      url: `http://127.0.0.1:${serverPort}/health`,
      env: environment,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1',
      cwd: 'apps/workbench-web',
      url: `${baseURL}/automations`,
      env: environment,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
