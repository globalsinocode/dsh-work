import { defineConfig, devices } from '@playwright/test'

// P1 DingTalk journeys (e2e/catalog/dingtalk.md): real application, disposable database and a fake DingTalk
// Open Platform HTTP service started by scripts/testing/dingtalk-browser.ts. Not a real DingTalk acceptance.
const adminPort = process.env.DSH_WORK_DINGTALK_E2E_ADMIN_PORT ?? '4681'
const workbenchPort = process.env.DSH_WORK_DINGTALK_E2E_WORKBENCH_PORT ?? '4675'
const serverPort = process.env.DSH_WORK_DINGTALK_E2E_SERVER_PORT ?? '4691'
const fakePort = process.env.DSH_WORK_DINGTALK_E2E_FAKE_PORT ?? '4699'
const environment = {
  ...process.env,
  DSH_WORK_DINGTALK_E2E_ADMIN_PORT: adminPort,
  DSH_WORK_DINGTALK_E2E_WORKBENCH_PORT: workbenchPort,
  DSH_WORK_DINGTALK_E2E_SERVER_PORT: serverPort,
  DSH_WORK_DINGTALK_E2E_FAKE_PORT: fakePort,
  DSH_WORK_SERVER_PORT: serverPort,
  DSH_WORK_ADMIN_PORT: adminPort,
  DSH_WORK_WORKBENCH_PORT: workbenchPort,
  VITE_ADMIN_URL: `http://localhost:${adminPort}`,
  VITE_WORKBENCH_URL: `http://localhost:${workbenchPort}`,
}

export default defineConfig({
  outputDir: 'test-results/dingtalk',
  testDir: './e2e', testMatch: 'dingtalk.integration.spec.ts',
  workers: 1, fullyParallel: false, retries: 0, reporter: 'list',
  use: {
    ...devices['Desktop Chrome'], baseURL: `http://localhost:${adminPort}`,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: [
    { command: 'node --env-file-if-exists=.env --experimental-strip-types scripts/testing/dingtalk-browser.ts', url: `http://127.0.0.1:${serverPort}/health`, env: environment, reuseExistingServer: false, timeout: 60_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1', cwd: 'apps/admin-web', url: `http://localhost:${adminPort}/login`, env: environment, reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1', cwd: 'apps/workbench-web', url: `http://localhost:${workbenchPort}/login`, env: environment, reuseExistingServer: false },
  ],
})
