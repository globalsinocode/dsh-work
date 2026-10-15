import { defineConfig, devices } from '@playwright/test'

// The default suite is P0: a test-only smoke server with in-memory data and test
// identities (scripts/testing/p0-smoke-server.ts). It never reads PostgreSQL/OIDC
// settings. Publish the chosen ports to test workers as well as the three processes.
const workbenchPort = process.env.DSH_WORK_WORKBENCH_PORT ||= '4274'
const adminPort = process.env.DSH_WORK_ADMIN_PORT ||= '4280'
const serverPort = process.env.DSH_WORK_SERVER_PORT ||= '4290'
const workbenchUrl = `http://localhost:${workbenchPort}`
const adminUrl = `http://localhost:${adminPort}`
const serverUrl = `http://localhost:${serverPort}`
const smokeEnvironment = {
  NODE_ENV: 'development',
  DSH_WORK_WORKBENCH_PORT: workbenchPort,
  DSH_WORK_ADMIN_PORT: adminPort,
  DSH_WORK_SERVER_PORT: serverPort,
  VITE_ADMIN_URL: adminUrl,
  VITE_WORKBENCH_URL: workbenchUrl,
  VITE_ADMIN_API_BASE_URL: '/api/admin/v1',
  VITE_WORKBENCH_API_BASE_URL: '/api/workbench/v1',
}

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/personal-integration/**', '**/*.integration.spec.ts'],
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    // Browser navigation, sibling-app links and readiness checks use one origin.
    baseURL: workbenchUrl,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'node --experimental-strip-types scripts/testing/p0-smoke-server.ts',
      url: `${serverUrl}/health`,
      env: smokeEnvironment,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'pnpm dev:workbench',
      url: `${workbenchUrl}/workbench`,
      env: smokeEnvironment,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'pnpm dev:admin',
      url: `${adminUrl}/overview`,
      env: smokeEnvironment,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
