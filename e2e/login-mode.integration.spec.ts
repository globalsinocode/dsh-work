import { expect, test as base, type Locator, type Page } from '@playwright/test'

const adminUrl = `http://localhost:${process.env.DSH_WORK_LOCAL_AUTH_ADMIN_PORT ?? '4780'}`
const settingsPath = '/api/admin/v1/identity/login-settings'

async function openSettings(page: Page, reader = false) {
  await page.goto(`${adminUrl}/login-settings`)
  await page.getByLabel('登录账号', { exact: true }).fill(reader ? 'browser.reader' : 'browser.admin')
  await page.getByLabel('密码', { exact: true }).fill(reader ? 'browser-only reader passphrase' : 'browser-only admin passphrase')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(`${adminUrl}/login-settings`)
  const panel = page.getByRole('region', { name: '登录模式配置', exact: true })
  await expect(panel.getByText('当前生效', { exact: true })).toBeVisible()
  return panel
}

async function restoreLocalMode(page: Page) {
  const response = await page.request.get(`${adminUrl}${settingsPath}`)
  expect(response.ok()).toBe(true)
  const { data } = await response.json()
  if (data.savedMode !== 'local') {
    const saved = await page.request.patch(`${adminUrl}${settingsPath}`, {
      headers: { Origin: adminUrl }, data: { mode: 'local', expectedRevision: data.revision },
    })
    expect(saved.ok()).toBe(true)
  }
}

const test = base.extend<{ adminSettings: Locator }>({
  adminSettings: async ({ page }, use) => {
    const panel = await openSettings(page)
    try { await use(panel) }
    finally { await restoreLocalMode(page) }
  },
})

test('LOGIN-MODE-P1 administrator saves, reloads and cancels a pending switch without changing the live login', async ({ page, adminSettings: panel }, testInfo) => {
  const navigation = page.getByRole('navigation', { name: '管理后台主导航' })
  await expect(navigation.getByRole('button', { name: '平台设置', exact: true })).toBeVisible()
  await navigation.getByRole('button', { name: '员工与权限', exact: true }).click()
  await expect(page.getByRole('tab')).toHaveText(['员工授权', '角色与权限'])
  const employeeDataRequests: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (/\/api\/admin\/v1\/identity\/(users|roles|directory-sync|permissions)/.test(path)) employeeDataRequests.push(path)
  })
  await navigation.getByRole('button', { name: '登录设置', exact: true }).click()
  await expect(page).toHaveURL(`${adminUrl}/login-settings`)
  await expect(page.getByRole('main').getByRole('tab')).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('table')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '保存登录模式', exact: true })).toBeDisabled()
  await panel.getByRole('radiogroup', { name: '选择登录方式' }).getByText('AI Hub 统一登录', { exact: true }).click()
  await panel.getByRole('button', { name: '保存登录模式', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '确认修改登录模式', exact: true })
  await expect(confirmation).toContainText('所有用户都需重新登录')
  await confirmation.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(panel.getByText('重启后生效', { exact: true })).toBeVisible()
  await expect(panel.getByRole('definition').first()).toHaveText('独立账号密码')
  expect((await page.request.get(`${adminUrl}/auth/admin/configuration`).then(response => response.json())).mode).toBe('local')
  await page.reload()
  await expect(page).toHaveURL(`${adminUrl}/login-settings`)
  await expect(panel.getByRole('radio', { name: 'AI Hub 统一登录', exact: true })).toBeChecked()
  await expect(panel.getByText('重启后生效', { exact: true })).toBeVisible()
  await navigation.getByRole('button', { name: '登录设置', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('login-mode-pending.png'), fullPage: true, animations: 'disabled' })

  await panel.getByRole('radiogroup', { name: '选择登录方式' }).getByText('独立账号密码', { exact: true }).click()
  await panel.getByRole('button', { name: '保存登录模式', exact: true }).click()
  await page.getByRole('dialog', { name: '取消登录模式切换', exact: true }).getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(panel.getByText('已生效', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '刷新设置', exact: true }).click()
  await expect(panel.getByRole('radio', { name: '独立账号密码', exact: true })).toBeChecked()
  await expect(panel.getByRole('button', { name: '保存登录模式', exact: true })).toBeDisabled()
  expect(employeeDataRequests).toEqual([])
})

test('LOGIN-MODE-P1 concurrent changes require a refresh and explicit reconfirmation', async ({ page, adminSettings: panel }) => {
  const { data } = await page.request.get(`${adminUrl}${settingsPath}`).then(response => response.json())
  await panel.getByRole('radiogroup', { name: '选择登录方式' }).getByText('AI Hub 统一登录', { exact: true }).click()
  const otherSave = await page.request.patch(`${adminUrl}${settingsPath}`, {
    headers: { Origin: adminUrl }, data: { mode: 'oidc', expectedRevision: data.revision },
  })
  expect(otherSave.ok()).toBe(true)
  await panel.getByRole('button', { name: '保存登录模式', exact: true }).click()
  await page.getByRole('dialog', { name: '确认修改登录模式', exact: true }).getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('登录设置已被修改')
  await expect(panel.getByRole('button', { name: '保存登录模式', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: '刷新设置', exact: true }).click()
  await expect(panel.getByRole('alert').filter({ hasText: '登录设置已被修改' })).toHaveCount(0)
  await expect(panel.getByText('重启后生效', { exact: true })).toBeVisible()
  await expect(panel.getByRole('radio', { name: 'AI Hub 统一登录', exact: true })).toBeChecked()
})

test('LOGIN-MODE-P1 read-only administrator can inspect settings but cannot change them through UI or API', async ({ page }) => {
  const panel = await openSettings(page, true)
  await expect(page.getByRole('navigation', { name: '管理后台主导航' }).getByRole('button', { name: '登录设置', exact: true })).toBeVisible()
  await expect(panel.getByText('仅平台管理员可以修改登录模式。')).toBeVisible()
  await expect(panel.getByRole('radio')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '保存登录模式', exact: true })).toHaveCount(0)
  const { data } = await page.request.get(`${adminUrl}${settingsPath}`).then(response => response.json())
  const rejected = await page.request.patch(`${adminUrl}${settingsPath}`, {
    headers: { Origin: adminUrl }, data: { mode: 'oidc', expectedRevision: data.revision },
  })
  expect(rejected.status()).toBe(403)
  const after = await page.request.get(`${adminUrl}${settingsPath}`).then(response => response.json())
  expect(after.data.revision).toBe(data.revision)
})
