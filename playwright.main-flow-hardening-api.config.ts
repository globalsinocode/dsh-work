import { defineConfig } from '@playwright/test'

import base from './playwright.main-flow-hardening.config.ts'

const serverPort = process.env.DSH_WORK_HARDENING_SERVER_PORT ?? '4392'

export default defineConfig({
  ...base,
  testMatch: [
    'conversation-reliability.integration.spec.ts',
    'workspace-notifications.integration.spec.ts',
    'content-workspace-contracts.integration.spec.ts',
  ],
  grep: /NT-01|CW-04|CR-01/,
  use: {
    ...base.use,
    baseURL: `http://127.0.0.1:${serverPort}`,
  },
  webServer: [base.webServer![0]],
})
