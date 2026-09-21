import { defineConfig, devices } from '@playwright/test'

const adminPort = process.env.DSH_WORK_MCP_ADMIN_WEB_PORT ?? '4380'
const serverPort = process.env.DSH_WORK_MCP_ADMIN_SERVER_PORT ?? '4392'
const baseURL = `http://localhost:${adminPort}`
const environment = {
  ...process.env,
  DSH_WORK_MCP_ADMIN_SERVER_PORT: serverPort,
  DSH_WORK_SERVER_PORT: serverPort,
  DSH_WORK_ADMIN_PORT: adminPort,
}

export default defineConfig({
  testDir: './e2e',
  testMatch: 'admin-mcp-connector.integration.spec.ts',
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
      command: 'node --env-file-if-exists=.env --experimental-strip-types scripts/testing/admin-mcp-connector-browser.ts',
      url: `http://127.0.0.1:${serverPort}/health`,
      env: environment,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1',
      cwd: 'apps/admin-web',
      url: `${baseURL}/connectors`,
      env: environment,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
