import config from './playwright.conversation-reliability.config.ts'

export default { ...config, testMatch: 'content-workspace-contracts.integration.spec.ts' }
