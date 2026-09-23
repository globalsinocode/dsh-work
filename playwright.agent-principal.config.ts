import { defineConfig } from '@playwright/test'
import adminMcpConfig from './playwright.mcp-admin.config.ts'

export default defineConfig({
  ...adminMcpConfig,
  testMatch: 'agent-principal.integration.spec.ts',
})
