import { defineConfig, devices } from '@playwright/test'

const adminPort = process.env.DSH_WORK_LOCAL_AUTH_ADMIN_PORT ?? '4780'
const workbenchPort = process.env.DSH_WORK_LOCAL_AUTH_WORKBENCH_PORT ?? '4774'
const serverPort = process.env.DSH_WORK_LOCAL_AUTH_SERVER_PORT ?? '4790'
const environment = {
  ...process.env,
  DSH_WORK_LOCAL_AUTH_ADMIN_PORT: adminPort,
  DSH_WORK_LOCAL_AUTH_WORKBENCH_PORT: workbenchPort,
  DSH_WORK_LOCAL_AUTH_SERVER_PORT: serverPort,
  DSH_WORK_SERVER_PORT: serverPort,
  DSH_WORK_ADMIN_PORT: adminPort,
  DSH_WORK_WORKBENCH_PORT: workbenchPort,
  VITE_ADMIN_URL: `http://localhost:${adminPort}`,
  VITE_WORKBENCH_URL: `http://localhost:${workbenchPort}`,
}

export default defineConfig({
  outputDir: 'test-results/login-mode',
  testDir: './e2e', testMatch: 'login-mode.integration.spec.ts',
  workers: 1, fullyParallel: false, retries: 0, reporter: 'list',
  use: {
    ...devices['Desktop Chrome'], baseURL: `http://localhost:${adminPort}`,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: [
    { command: 'node --env-file-if-exists=.env --experimental-strip-types scripts/testing/local-auth-browser.ts --login-settings', url: `http://127.0.0.1:${serverPort}/health`, env: environment, reuseExistingServer: false, timeout: 60_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1', cwd: 'apps/admin-web', url: `http://localhost:${adminPort}/login`, env: environment, reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1', cwd: 'apps/workbench-web', url: `http://localhost:${workbenchPort}/login`, env: environment, reuseExistingServer: false },
  ],
})
