import { defineConfig, devices } from '@playwright/test'

const workbenchPort = Number(process.env.DSH_WORK_WORKBENCH_PORT ?? 4174)
const adminPort = Number(process.env.DSH_WORK_ADMIN_PORT ?? 4180)
const serverPort = Number(process.env.DSH_WORK_SERVER_PORT ?? 4190)
const workbenchUrl = `http://localhost:${workbenchPort}`
const adminUrl = `http://localhost:${adminPort}`
const serverUrl = `http://localhost:${serverPort}`

export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/personal-integration/**',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    // 必须与 OIDC 允许来源同源：本机 .env 的 AI_HUB_WORKBENCH_PORTAL_URL 是
    // http://localhost:4174、AI_HUB_ADMIN_PORTAL_URL 是 http://localhost:4180，
    // 服务端按请求入口 Origin 校验（127.0.0.1 会得到 421 unknown_request_origin）。
    // 因此浏览器导航与 webServer 健康检查一律使用 localhost，不要改回 127.0.0.1。
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
      command: 'pnpm dev:server',
      url: `${serverUrl}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'pnpm dev:workbench',
      url: `${workbenchUrl}/workbench`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'pnpm dev:admin',
      url: `${adminUrl}/overview`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
})
