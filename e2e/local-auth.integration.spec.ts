import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'

const adminUrl = `http://localhost:${process.env.DSH_WORK_LOCAL_AUTH_ADMIN_PORT ?? '4680'}`
const workbenchUrl = `http://localhost:${process.env.DSH_WORK_LOCAL_AUTH_WORKBENCH_PORT ?? '4674'}`
const initialPassword = 'browser-only employee initial passphrase'
const privatePassword = 'browser-only employee private passphrase'

async function signIn(page: Page, username: string, password: string) {
  await page.getByLabel('登录账号', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

test('LOCAL-AUTH-P1 administrator provisions an employee, changes revoke sessions, and logout stays local', async ({ page, browser }, testInfo) => {
  const username = `employee.${randomUUID().slice(0, 8)}`
  const unexpectedRequests: string[] = []
  const recordRequest = (url: string) => { if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) unexpectedRequests.push(url) }
  page.on('request', request => recordRequest(request.url()))
  await page.goto(`${adminUrl}/identity`)
  await expect(page.getByRole('heading', { name: '登录管理后台' })).toBeVisible()
  await signIn(page, 'browser.admin', 'intentionally wrong')
  await expect(page.getByRole('alert')).toContainText('账号或密码错误')
  await signIn(page, 'browser.admin', 'browser-only admin passphrase')
  await expect(page).toHaveURL(`${adminUrl}/identity`)
  await expect(page.getByRole('button', { name: '同步员工', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '新建账号', exact: true }).click()
  const form = page.getByRole('dialog', { name: '新建账号', exact: true })
  await form.getByLabel('登录账号', { exact: true }).fill(username)
  await form.getByLabel('姓名', { exact: true }).fill('独立登录验收员工')
  await form.getByLabel('部门', { exact: true }).fill('合成测试部门')
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
    await employee.getByLabel('当前密码', { exact: true }).fill(initialPassword)
    await employee.getByLabel('新密码', { exact: true }).fill(privatePassword)
    await employee.getByLabel('确认新密码', { exact: true }).fill(privatePassword)
    await employee.getByRole('button', { name: '保存新密码', exact: true }).click()
    await expect(employee.getByRole('alert')).toContainText('密码已修改')
    await signIn(employee, username, initialPassword)
    await expect(employee.getByRole('alert').filter({ hasText: '账号或密码错误' })).toBeVisible()
    await signIn(employee, username, privatePassword)
    await expect(employee).toHaveURL(`${workbenchUrl}/settings`)
    await expect(employee.getByRole('heading', { name: '用户中心', exact: true })).toBeVisible()

    const denied = await employeeContext.newPage()
    await denied.goto(`${adminUrl}/identity`)
    await signIn(denied, username, privatePassword)
    await expect(denied.getByRole('alert')).toContainText('没有管理后台访问权限')
    await expect(denied.getByRole('button', { name: '新建账号', exact: true })).toHaveCount(0)
    await denied.close()

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

    await page.getByRole('row').filter({ hasText: 'browser.admin' }).getByRole('button', { name: '配置', exact: true }).click()
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
