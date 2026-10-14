import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'

const adminUrl = `http://localhost:${process.env.DSH_WORK_LOCAL_AUTH_ADMIN_PORT ?? '4680'}`
const workbenchUrl = `http://localhost:${process.env.DSH_WORK_LOCAL_AUTH_WORKBENCH_PORT ?? '4674'}`
const initialPassword = 'Initial1'
const privatePassword = 'Private12345'

async function signIn(page: Page, username: string, password: string) {
  await page.getByLabel('登录账号', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

test('LOCAL-AUTH-P1 administrator provisions an employee, changes revoke sessions, and logout stays local', async ({ page, browser }, testInfo) => {
  // Two password changes plus reset/status/logout checks perform multiple real scrypt verifications.
  test.setTimeout(60_000)
  const username = `employee.${randomUUID().slice(0, 8)}@example.invalid`
  const unexpectedRequests: string[] = []
  const recordRequest = (url: string) => { if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) unexpectedRequests.push(url) }
  page.on('request', request => recordRequest(request.url()))
  await page.goto(`${adminUrl}/identity`)
  await expect(page.getByRole('heading', { name: '登录运营平台' })).toBeVisible()
  await signIn(page, 'browser.admin@example.invalid', 'intentionally wrong')
  await expect(page.getByRole('alert')).toContainText('账号或密码错误')
  await signIn(page, 'browser.admin@example.invalid', 'AdminPass123')
  await expect(page).toHaveURL(`${adminUrl}/identity`)
  await expect(page.getByRole('button', { name: '同步员工', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '新建账号', exact: true }).click()
  const form = page.getByRole('dialog', { name: '新建账号', exact: true })
  await form.getByLabel('登录账号', { exact: true }).fill(username)
  await form.getByLabel('姓名', { exact: true }).fill('独立登录验收员工')
  await form.getByLabel('部门', { exact: true }).fill('合成测试部门')
  await form.getByLabel('初始密码', { exact: true }).fill('Short12')
  await form.getByRole('button', { name: '开通账号', exact: true }).click()
  await expect(form.getByText('密码需为 8–12 个字符', { exact: true })).toBeVisible()
  await form.getByLabel('初始密码', { exact: true }).fill(initialPassword)
  await form.getByRole('button', { name: '开通账号', exact: true }).click()
  await expect(form).toBeHidden()
  const row = page.getByRole('tabpanel', { name: '员工授权' }).getByRole('row').filter({ hasText: username })
  await row.getByRole('button', { name: '配置', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: '员工授权配置' })
  await drawer.getByRole('combobox', { name: '选择要分配的角色' }).click()
  await page.getByRole('option', { name: '普通员工', exact: true }).click()
  await drawer.getByRole('button', { name: '分配角色', exact: true }).click()
  await expect(drawer.getByText('普通员工', { exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: 'Close this dialog' }).click()

  const employeeContext = await browser.newContext()
  const employee = await employeeContext.newPage()
  employee.on('request', request => recordRequest(request.url()))
  try {
    await employee.goto(`${workbenchUrl}/settings`)
    await signIn(employee, username, initialPassword)
    await expect(employee.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible()
    await expect(employee.getByText('密码长度为 8–12 个字符。', { exact: true })).toBeVisible()
    const initialState = await employeeContext.storageState()
    await employee.getByLabel('当前密码', { exact: true }).fill('incorrect-current-password')
    await employee.getByLabel('新密码', { exact: true }).fill(privatePassword)
    await employee.getByLabel('确认新密码', { exact: true }).fill(privatePassword)
    await employee.getByRole('button', { name: '保存新密码', exact: true }).click()
    await expect(employee.getByRole('alert')).toContainText('当前密码错误')
    await expect(employee.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible()
    const navigations: string[] = []
    employee.on('framenavigated', frame => { if (frame === employee.mainFrame()) navigations.push(new URL(frame.url()).pathname) })
    await employee.getByLabel('当前密码', { exact: true }).fill(initialPassword)
    await employee.getByLabel('新密码', { exact: true }).fill(privatePassword)
    await employee.getByLabel('确认新密码', { exact: true }).fill(privatePassword)
    await employee.getByRole('button', { name: '保存新密码', exact: true }).click()
    await expect(employee).toHaveURL(`${workbenchUrl}/settings`)
    await expect(employee.getByRole('heading', { name: '用户中心', exact: true })).toBeVisible()
    expect(navigations).not.toContain('/login')
    const staleContext = await browser.newContext({ storageState: initialState })
    try {
      expect((await staleContext.request.get(`${workbenchUrl}/api/workbench/v1/session`)).status()).toBe(401)
    } finally { await staleContext.close() }
    const oldPassword = await employee.request.post(`${workbenchUrl}/auth/workbench/login`, { headers: { Origin: workbenchUrl }, data: { username, password: initialPassword } })
    expect(oldPassword.status()).toBe(401)
    await employee.reload()
    await expect(employee.getByRole('heading', { name: '用户中心', exact: true })).toBeVisible()

    const denied = await employeeContext.newPage()
    await denied.goto(`${adminUrl}/identity`)
    await signIn(denied, username, privatePassword)
    await expect(denied.getByRole('alert')).toContainText('没有管理后台访问权限')
    await expect(denied.getByRole('button', { name: '新建账号', exact: true })).toHaveCount(0)
    await denied.close()

    await row.getByRole('button', { name: '配置', exact: true }).click()
    await drawer.getByRole('button', { name: '重置密码', exact: true }).click()
    const resetForm = page.getByRole('dialog', { name: '重置密码', exact: true })
    await resetForm.getByLabel('初始密码', { exact: true }).fill('Short12')
    await resetForm.getByRole('button', { name: '重置密码', exact: true }).click()
    await expect(resetForm.getByText('密码需为 8–12 个字符', { exact: true })).toBeVisible()
    expect((await employee.request.get(`${workbenchUrl}/api/workbench/v1/session`)).status()).toBe(200)
    await resetForm.getByLabel('初始密码', { exact: true }).fill(initialPassword)
    await resetForm.getByRole('button', { name: '重置密码', exact: true }).click()
    await page.getByRole('dialog', { name: '确认重置密码', exact: true }).getByRole('button', { name: '确认', exact: true }).click()
    await expect(resetForm).toBeHidden()
    await drawer.getByRole('button', { name: 'Close this dialog' }).click()
    await employee.reload()
    await expect(employee.getByRole('heading', { name: '登录员工工作台' })).toBeVisible()
    await signIn(employee, username, initialPassword)
    await expect(employee.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible()
    await employee.getByLabel('当前密码', { exact: true }).fill(initialPassword)
    await employee.getByLabel('新密码', { exact: true }).fill(privatePassword)
    await employee.getByLabel('确认新密码', { exact: true }).fill(privatePassword)
    await employee.getByRole('button', { name: '保存新密码', exact: true }).click()
    await expect(employee).toHaveURL(`${workbenchUrl}/settings`)
    await expect(employee.getByRole('heading', { name: '用户中心', exact: true })).toBeVisible()

    await row.getByRole('button', { name: '配置', exact: true }).click()
    await drawer.getByRole('button', { name: '停用账号', exact: true }).click()
    await page.getByRole('dialog', { name: '确认停用账号' }).getByRole('button', { name: '确认', exact: true }).click()
    await expect(drawer.getByRole('button', { name: '启用账号', exact: true })).toBeVisible()
    await employee.reload()
    await expect(employee.getByRole('heading', { name: '登录员工工作台' })).toBeVisible()
    await signIn(employee, username, privatePassword)
    await expect(employee.getByRole('alert')).toContainText('账号或密码错误')

    await drawer.getByRole('button', { name: '启用账号', exact: true }).click()
    await page.getByRole('dialog', { name: '确认启用账号' }).getByRole('button', { name: '确认', exact: true }).click()
    await expect(drawer.getByRole('button', { name: '停用账号', exact: true })).toBeVisible()
    await signIn(employee, username, privatePassword)
    await expect(employee.getByRole('heading', { name: '用户中心', exact: true })).toBeVisible()
    await employee.getByRole('button', { name: '打开用户中心' }).click()
    await employee.getByRole('menuitem', { name: '退出登录', exact: true }).click()
    await expect(employee).toHaveURL(`${workbenchUrl}/login`)
    await drawer.getByRole('button', { name: 'Close this dialog' }).click()

    await page.getByRole('row').filter({ hasText: 'browser.admin@example.invalid' }).getByRole('button', { name: '配置', exact: true }).click()
    await drawer.getByRole('button', { name: '停用账号', exact: true }).click()
    await page.getByRole('dialog', { name: '确认停用账号' }).getByRole('button', { name: '确认', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: '不能移除最后一个有效的平台管理员' }).first()).toBeVisible()
    await expect(drawer.getByRole('button', { name: '停用账号', exact: true })).toBeVisible()
    await drawer.getByRole('button', { name: 'Close this dialog' }).click()
    await page.reload()
    await expect(row).toBeVisible()
    await expect(row.getByText('普通员工', { exact: true })).toBeVisible()
    await expect(row.getByText('有效', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('local-account-management.png'), fullPage: true, animations: 'disabled' })
    expect(unexpectedRequests).toEqual([])
  } finally {
    await employeeContext.close()
  }
})

test('LOCAL-AUTH-P1 a newly provisioned administrator changes the initial password and enters the requested page directly', async ({ page, browser, request }, testInfo) => {
  const username = `admin.${randomUUID().slice(0, 8)}@example.invalid`
  const target = `${adminUrl}/identity?view=employees#accounts`
  const headers = { Origin: adminUrl }
  const setupLogin = await request.post(`${adminUrl}/auth/admin/login`, { headers, data: { username: 'browser.admin@example.invalid', password: 'AdminPass123' } })
  expect(setupLogin.status()).toBe(200)
  const created = await request.post(`${adminUrl}/api/admin/v1/identity/users`, { headers, data: { username, name: '首次改密验收管理员', password: initialPassword } })
  expect(created.status()).toBe(200)
  const userId = (await created.json()).data.userId
  const granted = await request.post(`${adminUrl}/api/admin/v1/identity/users/${userId}/roles`, { headers, data: { roleId: 'role-platform-admin' } })
  expect(granted.status()).toBe(200)

  await page.goto(target)
  await signIn(page, username, initialPassword)
  await expect(page.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible()
  const initialState = await page.context().storageState()
  const navigations: string[] = []
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(new URL(frame.url()).pathname) })
  await page.getByLabel('当前密码', { exact: true }).fill(initialPassword)
  await page.getByLabel('新密码', { exact: true }).fill(privatePassword)
  await page.getByLabel('确认新密码', { exact: true }).fill(privatePassword)
  await page.getByRole('button', { name: '保存新密码', exact: true }).click()
  await expect(page).toHaveURL(target)
  await expect(page.getByRole('tabpanel', { name: '员工授权' }).getByRole('row').filter({ hasText: username })).toBeVisible()
  expect(navigations).not.toContain('/login')
  const staleContext = await browser.newContext({ storageState: initialState })
  try {
    expect((await staleContext.request.get(`${adminUrl}/api/admin/v1/session`)).status()).toBe(401)
  } finally { await staleContext.close() }
  await page.reload()
  await expect(page).toHaveURL(target)
  await expect(page.getByRole('tabpanel', { name: '员工授权' }).getByRole('row').filter({ hasText: username })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('admin-after-first-password-change.png'), fullPage: true, animations: 'disabled' })
})

test('LOCAL-AUTH-P1 login is accessible at phone width and configuration failures can be retried', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/auth/admin/configuration', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
  await page.goto(`${adminUrl}/login`)
  await expect(page.getByRole('alert')).toContainText('暂时无法加载登录配置')
  await page.unroute('**/auth/admin/configuration')
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByLabel('登录账号', { exact: true })).toBeVisible()
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /注册/ })).toHaveCount(0)
  await page.getByLabel('登录账号', { exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('密码', { exact: true })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('local-login-mobile.png'), fullPage: true })
})

for (const portal of [{ audience: 'admin', url: adminUrl, heading: '登录运营平台' }, { audience: 'workbench', url: workbenchUrl, heading: '登录员工工作台' }]) {
  test(`LOGIN-ENTRY-P1 ${portal.audience} defaults to password and hides unconfigured AI Hub`, async ({ page }, testInfo) => {
    const upstreamRequests: string[] = []
    page.on('request', request => { if (request.url().includes('/oidc/login')) upstreamRequests.push(request.url()) })
    await page.goto(`${portal.url}/login?return_to=${encodeURIComponent('/settings?view=profile#details')}`)
    await expect(page.getByRole('heading', { name: portal.heading, exact: true })).toBeVisible()
    await expect(page.getByLabel('登录账号', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: /注册/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '使用 AI Hub 账号登录', exact: true })).toHaveCount(0)
    await expect(page.getByText('其他登录方式', { exact: true })).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('return_to')).toBe('/settings?view=profile#details')
    expect(upstreamRequests).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`${portal.audience}-password-login.png`), fullPage: true })
    await page.setViewportSize({ width: 320, height: 740 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeInViewport()
  })

  // Controlled browser response verifies navigation wiring, not a real OIDC provider.
  test(`LOGIN-ENTRY-P1 ${portal.audience} starts AI Hub with one click and retains the return target`, async ({ page }) => {
    await page.route(`**/auth/${portal.audience}/configuration`, route => route.fulfill({ json: { mode: 'oidc', localEnabled: true, aiHubEnabled: true } }))
    let destination: URL | undefined
    await page.route(`**/auth/${portal.audience}/oidc/login?*`, route => {
      destination = new URL(route.request().url())
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>受控 AI Hub 登录入口</h1>' })
    })
    await page.goto(`${portal.url}/login?return_to=${encodeURIComponent('/settings?view=profile#details')}`)
    await expect(page.getByLabel('登录账号', { exact: true })).toBeVisible()
    expect(destination).toBeUndefined()
    await page.getByRole('button', { name: '使用 AI Hub 账号登录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '受控 AI Hub 登录入口' })).toBeVisible()
    expect(destination?.pathname).toBe(`/auth/${portal.audience}/oidc/login`)
    expect(destination?.searchParams.get('return_to')).toBe('/settings?view=profile#details')
  })

  test(`LOGIN-ENTRY-P1 ${portal.audience} returns upstream errors directly to the password form`, async ({ page }) => {
    await page.goto(`${portal.url}/login?provider=ai-hub&auth_error=ai_hub_unavailable&return_to=%2Fsettings`)
    await expect(page.getByRole('alert')).toContainText('AI Hub 暂不可用')
    await expect(page.getByLabel('登录账号', { exact: true })).toBeVisible()
    await expect(page.getByLabel('密码', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled()
    await expect(page.getByRole('heading', { name: 'AI Hub 企业登录', exact: true })).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('return_to')).toBe('/settings')
  })
}

test('LOCAL-AUTH-P1 phone accounts accept +86 and prevent duplicate equivalent numbers', async ({ page }) => {
  const phone = `138${randomInt(10_000_000, 100_000_000)}`
  await page.goto(`${adminUrl}/identity`)
  await signIn(page, 'browser.admin@example.invalid', 'AdminPass123')
  await page.getByRole('button', { name: '新建账号', exact: true }).click()
  const form = page.getByRole('dialog', { name: '新建账号', exact: true })
  await form.getByLabel('登录账号', { exact: true }).fill(`+86${phone}`)
  await form.getByLabel('姓名', { exact: true }).fill('手机号验收员工')
  await form.getByLabel('初始密码', { exact: true }).fill(initialPassword)
  await form.getByRole('button', { name: '开通账号', exact: true }).click()
  await expect(form).toBeHidden()
  await expect(page.getByRole('tabpanel', { name: '员工授权' }).getByText(phone, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建账号', exact: true }).click()
  for (const account of [phone, `+86${phone}`]) {
    await form.getByLabel('登录账号', { exact: true }).fill(account)
    await form.getByLabel('登录账号', { exact: true }).press('Tab')
    await expect(form.getByText('登录账号已存在，请使用其他手机号或邮箱', { exact: true })).toBeVisible()
  }
})
