import { defineConfig, devices } from '@playwright/test'

const webPort = process.env.DSH_WORK_HARDENING_WEB_PORT ?? '4382'
const serverPort = process.env.DSH_WORK_HARDENING_SERVER_PORT ?? '4392'
const baseURL = `http://localhost:${webPort}`
const environment = {
  ...process.env,
  DSH_WORK_HARDENING_SERVER_PORT: serverPort,
  DSH_WORK_SERVER_PORT: serverPort,
  DSH_WORK_WORKBENCH_PORT: webPort,
}

export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'conversation-reliability.integration.spec.ts',
    'content-workspace-contracts.integration.spec.ts',
    'workspace-notifications.integration.spec.ts',
    'version-selection-export.integration.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    extraHTTPHeaders: { 'x-test-user-id': 'U00001' },
    ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: [
    {
      command: 'node --env-file-if-exists=.env --experimental-strip-types scripts/testing/main-flow-hardening-browser.ts',
      url: `http://127.0.0.1:${serverPort}/health`,
      env: environment,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'corepack pnpm dev --host 127.0.0.1',
      cwd: 'apps/workbench-web',
      url: `${baseURL}/workbench`,
      env: environment,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
