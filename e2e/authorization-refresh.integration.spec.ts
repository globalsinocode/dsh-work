import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'

const adminUrl = `http://localhost:${process.env.DSH_WORK_AUTH_REFRESH_ADMIN_PORT ?? '4681'}`
const workbenchUrl = `http://localhost:${process.env.DSH_WORK_AUTH_REFRESH_WORKBENCH_PORT ?? '4675'}`

async function signIn(page: Page, username: string, password: string) {
  await page.getByLabel('登录账号', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

test('AR-01 admin navigation converges after role revocation without replaying writes', async ({ browser, page }) => {
  test.setTimeout(90_000)
  const username = `writer.${randomUUID().slice(0, 8)}@example.invalid`
  const password = 'Writer1234'
  await page.goto(`${adminUrl}/identity`)
  await signIn(page, 'browser.admin@example.invalid', 'AdminPass123')
  await page.getByRole('button', { name: '新建账号', exact: true }).click()
  const form = page.getByRole('dialog', { name: '新建账号', exact: true })
  await form.getByLabel('登录账号', { exact: true }).fill(username)
  await form.getByLabel('姓名', { exact: true }).fill('撤权验收管理员')
  await form.getByLabel('初始密码', { exact: true }).fill(password)
  await form.getByRole('button', { name: '开通账号', exact: true }).click()
  const row = page.getByRole('tabpanel', { name: '员工授权' }).getByRole('row').filter({ hasText: username })
  await row.getByRole('button', { name: '配置', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '员工授权配置' })
  for (const role of ['业务管理员', '安全审计员'] as const) {
    await drawer.getByRole('combobox', { name: '选择要分配的角色' }).click()
    await page.getByRole('option', { name: role, exact: true }).click()
    await drawer.getByRole('button', { name: '分配角色', exact: true }).click()
  }
  await drawer.getByRole('button', { name: 'Close this dialog' }).click()

  const writerContext = await browser.newContext()
  const writer = await writerContext.newPage()
  const sessionRequests: string[] = []
  writer.on('request', request => {
    if (request.url().includes('/api/admin/v1/session')) sessionRequests.push(request.method())
  })
  try {
    await writer.goto(`${adminUrl}/overview`)
    await signIn(writer, username, password)
    await expect(writer.getByRole('button', { name: 'Agent 管理', exact: true })).toBeVisible()

    await page.bringToFront()
    await row.getByRole('button', { name: '配置', exact: true }).click()
    await drawer.getByRole('button', { name: '移除', exact: true }).first().click()
    await page.getByRole('dialog', { name: '移除角色', exact: true }).getByRole('button', { name: '移除角色', exact: true }).click()
    await drawer.getByRole('button', { name: 'Close this dialog' }).click()

    await writer.bringToFront()
    const failedWrite = writer.waitForResponse(response =>
      response.url().includes('/api/admin/v1/agents') && response.request().method() === 'POST' && response.status() === 403,
    )
    await writer.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await writer.goto(`${adminUrl}/agents`)
    await failedWrite.catch(() => undefined)
    await expect(writer.getByRole('button', { name: 'Agent 管理', exact: true })).toHaveCount(0)
    expect(sessionRequests.filter(method => method === 'GET').length).toBeLessThanOrEqual(3)
  } finally {
    await writerContext.close()
  }
})

test('AR-02 admin without roles lands on forbidden view without login loop', async ({ browser }) => {
  test.setTimeout(90_000)
  const username = `norole.${randomUUID().slice(0, 8)}@example.invalid`
  const password = 'NoRole1234'
  const admin = await browser.newPage()
  await admin.goto(`${adminUrl}/identity`)
  await signIn(admin, 'browser.admin@example.invalid', 'AdminPass123')
  await admin.getByRole('button', { name: '新建账号', exact: true }).click()
  const form = admin.getByRole('dialog', { name: '新建账号', exact: true })
  await form.getByLabel('登录账号', { exact: true }).fill(username)
  await form.getByLabel('姓名', { exact: true }).fill('无角色管理员')
  await form.getByLabel('初始密码', { exact: true }).fill(password)
  await form.getByRole('button', { name: '开通账号', exact: true }).click()
  await admin.keyboard.press('Escape')

  const writer = await browser.newPage()
  try {
    await writer.goto(`${adminUrl}/overview`)
    await signIn(writer, username, password)
    await expect(writer.getByText(/无权限|没有权限|无法访问/).first()).toBeVisible()
    await writer.goto(`${adminUrl}/agents`)
    await expect(writer.getByText(/无权限|没有权限|无法访问/).first()).toBeVisible()
    expect(writer.url()).not.toContain('/login')
  } finally {
    await writer.close()
    await admin.close()
  }
})

test('AR-03 employee identity summary updates after scope revocation', async ({ browser, page }) => {
  test.setTimeout(90_000)
  const username = `scope.${randomUUID().slice(0, 8)}@example.invalid`
  const password = 'Scope12345'
  await page.goto(`${adminUrl}/identity`)
  await signIn(page, 'browser.admin@example.invalid', 'AdminPass123')
  await page.getByRole('button', { name: '新建账号', exact: true }).click()
  const form = page.getByRole('dialog', { name: '新建账号', exact: true })
  await form.getByLabel('登录账号', { exact: true }).fill(username)
  await form.getByLabel('姓名', { exact: true }).fill('范围撤权员工')
  await form.getByLabel('初始密码', { exact: true }).fill(password)
  await form.getByRole('button', { name: '开通账号', exact: true }).click()
  const row = page.getByRole('tabpanel', { name: '员工授权' }).getByRole('row').filter({ hasText: username })
  await row.getByRole('button', { name: '配置', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '员工授权配置' })
  await drawer.getByRole('combobox', { name: '选择要分配的角色' }).click()
  await page.getByRole('option', { name: '普通员工', exact: true }).click()
  await drawer.getByRole('button', { name: '分配角色', exact: true }).click()
  await drawer.getByRole('combobox').last().click()
  await page.getByRole('option', { name: 'region:east' }).click()
  await drawer.getByRole('button', { name: '保存数据范围', exact: true }).click()
  await drawer.getByRole('button', { name: 'Close this dialog' }).click()

  const employeeContext = await browser.newContext()
  const employee = await employeeContext.newPage()
  try {
    await employee.goto(`${workbenchUrl}/settings`)
    await signIn(employee, username, password)
    await expect(employee.getByText('region:east')).toBeVisible()

    await page.bringToFront()
    await row.getByRole('button', { name: '配置', exact: true }).click()
    await drawer.locator('.el-select__selected-item').filter({ hasText: 'region:east' }).locator('.el-tag__close').click()
    await drawer.getByRole('button', { name: '保存数据范围', exact: true }).click()
    await drawer.getByRole('button', { name: 'Close this dialog' }).click()

    await employee.bringToFront()
    await employee.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(employee.getByText('region:east')).toHaveCount(0)
    const protectedApi = await employee.request.get(`${workbenchUrl}/api/workbench/v1/automations`)
    expect(protectedApi.status()).toBeGreaterThanOrEqual(200)
  } finally {
    await employeeContext.close()
  }
})
