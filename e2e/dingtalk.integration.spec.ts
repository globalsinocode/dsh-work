import { expect, test, type Browser, type Page } from '@playwright/test'

// P1 钉钉接入旅程（e2e/catalog/dingtalk.md）：真实应用 + 可丢弃数据库 + 假钉钉开放平台 HTTP 服务
// （scripts/testing/dingtalk-browser.ts）。不是真实钉钉验收（DT-P2）。
// 夹具账号：管理员陈默；赵宁、王一凡、孙悦、李响未绑定；林岚本人绑定；何青管理员代绑；周婷需改初始密码；吴凡已被锁定。

const adminOrigin = `http://localhost:${process.env.DSH_WORK_DINGTALK_E2E_ADMIN_PORT ?? '4681'}`
const workbenchOrigin = `http://localhost:${process.env.DSH_WORK_DINGTALK_E2E_WORKBENCH_PORT ?? '4675'}`
const fakeDingTalk = `http://127.0.0.1:${process.env.DSH_WORK_DINGTALK_E2E_FAKE_PORT ?? '4699'}`
const employeePassword = 'Employee12345'
const dingTalkUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AliApp(DingTalk/7.6.0) DingTalk(7.6.0)'

/**
 * 钉钉容器替身：钉钉 User-Agent + 页面注入的 `window.dd`。`requestAuthCode` 向假钉钉服务为指定成员申请
 * 一次性授权码（真实钉钉由 JSAPI 签发）。只用于 P1，不能代替真机验收。
 */
async function dingTalkPage(browser: Browser, dingUserId: string) {
  const context = await browser.newContext({ userAgent: dingTalkUserAgent, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await context.addInitScript(({ fake, userId }) => {
    const target = window as unknown as { dd: unknown; __ddTitle?: string }
    target.dd = {
      runtime: { permission: { requestAuthCode: ({ corpId, onSuccess, onFail }: { corpId: string; onSuccess: (result: { code: string }) => void; onFail: (error: unknown) => void }) => {
        if (corpId !== 'ding-corp-e2e') return onFail({ errorMessage: 'corpId 不符' })
        void fetch(`${fake}/__test/auth-code`, { method: 'POST', body: JSON.stringify({ userId }) })
          .then(response => response.json() as Promise<{ code: string }>).then(result => onSuccess({ code: result.code }), onFail)
      } } },
      biz: { navigation: { setTitle: ({ title }: { title: string }) => { target.__ddTitle = title }, close: () => undefined } },
    }
  }, { fake: fakeDingTalk, userId: dingUserId })
  return { context, page: await context.newPage() }
}

async function passwordForm(page: Page, account: string, password = employeePassword) {
  await page.getByLabel('登录账号', { exact: true }).fill(account)
  await page.getByLabel('密码', { exact: true }).fill(password)
}

async function expectCollabShell(page: Page) {
  const navigation = page.getByRole('navigation', { name: '协作模式主导航' })
  await expect(navigation).toBeVisible()
  for (const label of ['对话', 'AI 同事', '群组', '定时任务']) await expect(navigation.getByRole('button', { name: label })).toBeVisible()
}

async function adminLogin(page: Page) {
  await page.goto(`${adminOrigin}/login`)
  await page.getByLabel('登录账号', { exact: true }).fill('dingtalk.admin@example.invalid')
  await page.getByLabel('密码', { exact: true }).fill('AdminPass123')
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(/\/overview/)
}

async function openEmployee(page: Page, account: string) {
  await page.goto(`${adminOrigin}/identity`)
  const row = page.getByRole('row').filter({ hasText: account })
  await row.getByRole('button', { name: '配置' }).click()
  const drawer = page.getByRole('dialog', { name: '员工授权配置' })
  await expect(drawer.getByRole('region', { name: '钉钉' })).toBeVisible()
  return drawer.getByRole('region', { name: '钉钉' })
}

async function lookup(panel: ReturnType<Page['getByRole']>, mobile: string) {
  await panel.getByRole('button', { name: '代为绑定钉钉' }).click()
  await panel.getByLabel('员工在钉钉中使用的手机号').fill(mobile)
  await panel.getByRole('button', { name: '在钉钉中查找' }).click()
}

test.describe('DT-ADM-03 管理员代绑、解绑与钉钉集成页', () => {
  test('员工列表显示钉钉状态并可按状态筛选', async ({ page }) => {
    await adminLogin(page)
    await page.goto(`${adminOrigin}/identity`)
    await expect(page.getByLabel('钉钉绑定概况')).toContainText('本人登录 1')
    await expect(page.getByLabel('钉钉绑定概况')).toContainText('管理员代绑 1')
    const linlan = page.getByRole('row').filter({ hasText: 'linlan@example.invalid' })
    await expect(linlan).toContainText('已绑定')
    await expect(linlan).toContainText('本人在钉钉内登录')
    await expect(page.getByRole('row').filter({ hasText: 'wufan@example.invalid' })).toContainText('已失效')

    // Element Plus 选择框的占位层盖在 combobox 上，点击外层选择框。
    await page.locator('.el-select').filter({ has: page.getByRole('combobox', { name: '筛选钉钉绑定' }) }).click()
    await page.getByRole('option', { name: '已绑定' }).click()
    await expect(page.getByRole('row').filter({ hasText: 'linlan@example.invalid' })).toBeVisible()
    await expect(page.getByRole('row').filter({ hasText: 'zhaoning@example.invalid' })).toHaveCount(0)
  })

  test('代为绑定：预览钉钉姓名与部门，确认后显示已绑定；解除并锁定自行绑定', async ({ page }) => {
    await adminLogin(page)
    const panel = await openEmployee(page, 'zhaoning@example.invalid')
    await expect(panel).toContainText('未绑定')
    await lookup(panel, '138 0000 2201')
    await expect(panel).toContainText('将绑定以下钉钉成员，请确认是本人')
    await expect(panel).toContainText('赵宁')
    await expect(panel).toContainText('销售部 · *******2201')
    await panel.getByRole('button', { name: '确认绑定' }).click()
    await expect(panel.getByRole('status')).toContainText('已绑定。已通知赵宁')
    await expect(panel).toContainText('管理员陈默代绑')
    await expect(panel).toContainText('赵宁（销售部）')

    await panel.getByRole('button', { name: '解除绑定' }).click()
    const dialog = page.getByRole('dialog', { name: '解除赵宁的钉钉绑定？' })
    await dialog.getByText('锁定自行绑定').click()
    await dialog.getByRole('button', { name: '解除绑定' }).click()
    await expect(panel).toContainText('已失效')
    await expect(panel).toContainText('已锁定自行绑定')
    await expect(panel.getByRole('button', { name: '解除锁定' })).toBeVisible()
  })

  test('钉钉姓名不一致须勾选“我已核实是本人”；号码不存在直接提示', async ({ page }) => {
    await adminLogin(page)
    const panel = await openEmployee(page, 'wangyf@example.invalid')
    await lookup(panel, '13800002202')
    await expect(panel).toContainText('钉钉姓名“王逸帆”与员工姓名“王一凡”不一致')
    const confirm = panel.getByRole('button', { name: '确认绑定' })
    await expect(confirm).toBeDisabled()
    await panel.getByText('我已核实是本人').click()
    await expect(confirm).toBeEnabled()
    await panel.getByRole('button', { name: '不是此人，重新输入' }).click()
    await panel.getByLabel('员工在钉钉中使用的手机号').fill('13900009999')
    await panel.getByRole('button', { name: '在钉钉中查找' }).click()
    await expect(panel.getByRole('alert')).toContainText('企业钉钉中没有找到这个手机号')
  })

  test('钉钉集成：连接检查、绑定情况、未绑定名单与提醒、通知投递说明', async ({ page }) => {
    await adminLogin(page)
    await page.getByRole('navigation', { name: '管理后台主导航' }).getByRole('button', { name: '钉钉集成' }).click()
    const config = page.getByRole('region', { name: '应用配置' })
    await expect(config).toContainText('3189001')
    await config.getByRole('button', { name: '重新检查连接' }).click()
    await expect(config.getByRole('status')).toContainText('连接正常')
    await expect(config.getByText('已开通', { exact: true })).toHaveCount(4)
    await expect(config.getByText('未开通', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: '绑定情况' })).toContainText('已绑定')

    await page.getByRole('region', { name: '绑定情况' }).getByRole('button', { name: '查看未绑定名单' }).click()
    const sunyue = page.getByRole('row').filter({ hasText: 'sunyue@example.invalid' })
    await expect(sunyue).toContainText('未绑定')
    const wufan = page.getByRole('row').filter({ hasText: 'wufan@example.invalid' })
    await expect(wufan).toContainText('已失效')
    await expect(wufan).toContainText('已锁定自行绑定')
    await expect(wufan.getByRole('button', { name: '提醒员工' })).toBeDisabled()
    await sunyue.getByRole('button', { name: '提醒员工' }).click()
    await expect(page.getByRole('status').filter({ hasText: '已提醒孙悦' })).toBeVisible()

    await page.getByRole('tab', { name: '通知投递' }).click()
    await expect(page.getByText('钉钉工作通知在下一阶段（DT-S2）启用')).toBeVisible()
  })
})

test.describe('DT-ADM-04 在钉钉集成页配置钉钉应用', () => {
  test('部署配置作为初始配置；页面修改参数后立即生效；凭据被钉钉拒绝时不保存', async ({ page }) => {
    await adminLogin(page)
    await page.goto(`${adminOrigin}/dingtalk`)
    const config = page.getByRole('region', { name: '应用配置' })
    await expect(config).toContainText('ding-corp-e2e')
    await expect(config).toContainText('部署配置（尚未在页面保存过）')
    await expect(config).toContainText('每位管理员 50 次')

    await config.getByRole('button', { name: '编辑配置' }).click()
    const dialog = page.getByRole('dialog', { name: '编辑钉钉应用配置' })
    await expect(dialog.getByLabel('AppSecret（Client Secret）')).toHaveAttribute('placeholder', /留空不修改/)
    await dialog.getByLabel('每位管理员每日代绑上限').fill('30')
    await dialog.getByRole('button', { name: '验证并保存' }).click()
    await expect(dialog).toBeHidden()
    await expect(config).toContainText('每位管理员 30 次')
    await expect(config).toContainText('管理端 · 陈默')
    await expect(config.getByRole('status')).toContainText('已保存，立即生效')

    await config.getByRole('button', { name: '编辑配置' }).click()
    await dialog.getByLabel('AppSecret（Client Secret）').fill('wrong-secret-0000')
    await dialog.getByRole('button', { name: '验证并保存' }).click()
    await expect(dialog.getByRole('alert')).toContainText('钉钉拒绝了这组凭据')
    await dialog.getByRole('button', { name: '取消' }).click()
    await page.reload()
    await expect(page.getByRole('region', { name: '应用配置' })).toContainText('每位管理员 30 次')
    // 原配置仍然有效：连接检查通过。
    await page.getByRole('region', { name: '应用配置' }).getByRole('button', { name: '重新检查连接' }).click()
    await expect(page.getByRole('region', { name: '应用配置' }).getByRole('status')).toContainText('连接正常')
  })
})

test.describe('DT-EMP-01 钉钉内首次登录即绑定与拒绝情形', () => {
  test('未绑定时显示绑定说明，登录即绑定并进入协作模式；之后在钉钉内免登', async ({ browser }) => {
    const { context, page } = await dingTalkPage(browser, 'ding-sunyue')
    await page.goto(`${workbenchOrigin}/c/groups`)
    await expect(page.getByRole('note', { name: '钉钉账号绑定说明' })).toContainText('当前钉钉账号：孙悦（销售部）')
    await expect(page.getByRole('note', { name: '钉钉账号绑定说明' })).toContainText('登录后将绑定此钉钉账号')
    await passwordForm(page, 'sunyue@example.invalid')
    await page.getByRole('button', { name: '登录并绑定' }).click()
    await expect(page).toHaveURL(/\/c\/groups/)
    await expect(page.getByRole('status').filter({ hasText: '已绑定钉钉账号，之后在钉钉内打开无需再登录' })).toBeVisible()
    await expectCollabShell(page)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ddTitle?: string }).__ddTitle)).toBeTruthy()

    // 关闭后再次打开（模拟会话 Cookie 不在）：自动免登，不出现登录表单。
    await context.clearCookies()
    await page.goto(`${workbenchOrigin}/c/chats`)
    await expect(page).toHaveURL(/\/c\/chats/)
    await expectCollabShell(page)
    await expect(page.getByLabel('登录账号', { exact: true })).toHaveCount(0)
    await context.close()
  })

  test('需先修改初始密码：改密后才绑定', async ({ browser }) => {
    const { context, page } = await dingTalkPage(browser, 'ding-zhouting')
    await page.goto(`${workbenchOrigin}/c/groups`)
    await passwordForm(page, 'zhouting@example.invalid')
    await page.getByRole('button', { name: '登录并绑定' }).click()
    await expect(page.getByRole('heading', { name: '请先修改初始密码' })).toBeVisible()
    await expect(page.getByText('修改后才会绑定钉钉账号')).toBeVisible()
    await page.getByLabel('当前密码', { exact: true }).fill(employeePassword)
    await page.getByLabel('新密码', { exact: true }).fill('Changed12345')
    await page.getByLabel('确认新密码', { exact: true }).fill('Changed12345')
    await page.getByRole('button', { name: '修改并绑定' }).click()
    await expect(page.getByRole('status').filter({ hasText: '密码已修改，并已绑定钉钉账号' })).toBeVisible()
    await expectCollabShell(page)
    await context.close()
  })

  test('本账号已绑定其他钉钉：说明原因，可不绑定继续使用', async ({ browser }) => {
    const { context, page } = await dingTalkPage(browser, 'ding-stranger')
    await page.goto(`${workbenchOrigin}/c/groups`)
    await expect(page.getByRole('note', { name: '钉钉账号绑定说明' })).toContainText('陌生人')
    await passwordForm(page, 'heqing@example.invalid')
    await page.getByRole('button', { name: '登录并绑定' }).click()
    await expect(page.getByRole('alert')).toContainText('你的账号已绑定另一个钉钉账号')
    await page.getByRole('button', { name: '不绑定，继续使用' }).click()
    await expect(page.getByRole('status').filter({ hasText: '本次未绑定钉钉' })).toBeVisible()
    await expectCollabShell(page)
    await context.close()
  })

  test('管理员已锁定自行绑定：说明原因，可不绑定继续使用', async ({ browser }) => {
    const { context, page } = await dingTalkPage(browser, 'ding-wufan')
    await page.goto(`${workbenchOrigin}/c/groups`)
    await passwordForm(page, 'wufan@example.invalid')
    await page.getByRole('button', { name: '登录并绑定' }).click()
    await expect(page.getByRole('alert')).toContainText('管理员已暂停你的钉钉自行绑定')
    await page.getByRole('button', { name: '不绑定，继续使用' }).click()
    await expectCollabShell(page)
    await context.close()
  })

  test('在钉钉内退出登录后不会被立即自动登录回去', async ({ browser }) => {
    const { context, page } = await dingTalkPage(browser, 'ding-heqing')
    await page.goto(`${workbenchOrigin}/c/chats`)
    await expectCollabShell(page)
    await page.getByRole('button', { name: '打开用户菜单' }).click()
    await page.getByRole('menuitem', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login\?logged_out=1/)
    await expect(page.getByText('已退出登录。从钉钉工作台重新打开 dsh-work 时会再次自动登录。')).toBeVisible()
    await expect(page.getByLabel('登录账号', { exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '协作模式主导航' })).toHaveCount(0)
    await context.close()
  })

  test('默认工作模式的员工在钉钉内进入协作模式，桌面浏览器仍是工作模式且偏好不变', async ({ browser }) => {
    const { context, page } = await dingTalkPage(browser, 'ding-linlan')
    await page.goto(`${workbenchOrigin}/workbench`)
    await expectCollabShell(page)
    await expect(page.getByRole('button', { name: '切换模式' })).toHaveCount(0)
    await context.close()

    const desktop = await browser.newContext()
    const desktopPage = await desktop.newPage()
    await desktopPage.goto(`${workbenchOrigin}/login`)
    await passwordForm(desktopPage, 'linlan@example.invalid')
    await desktopPage.getByRole('button', { name: '登录' }).click()
    await expect(desktopPage.getByRole('navigation', { name: '员工工作台主导航' })).toBeVisible()
    const preferences = await desktopPage.evaluate(() => fetch('/api/workbench/v1/me/preferences').then(response => response.json()))
    expect(preferences.data.uiMode).toBe('work')
    await desktop.close()
  })
})

test.describe('DT-EMP-02 用户中心 › 钉钉', () => {
  test('查看本人绑定并解除；解除后钉钉内需重新登录', async ({ browser }) => {
    const { context, page } = await dingTalkPage(browser, 'ding-linlan')
    await page.goto(`${workbenchOrigin}/settings?section=dingtalk`)
    const section = page.getByRole('region', { name: '钉钉' })
    await expect(section).toContainText('已绑定')
    await expect(section).toContainText('林岚（市场部）')
    await expect(section).toContainText('本人在钉钉内登录时绑定')
    await section.getByRole('button', { name: '解除绑定' }).click()
    const dialog = page.getByRole('dialog', { name: '解除钉钉绑定？' })
    await expect(dialog).toContainText('钉钉内的登录会立即失效')
    await dialog.getByRole('button', { name: '解除绑定' }).click()
    // 当前就是钉钉内的登录：会话随解绑失效，回到登录页，并重新显示绑定说明。
    await expect(page.getByRole('note', { name: '钉钉账号绑定说明' })).toContainText('林岚')
    await context.close()
  })

  test('管理员代绑的账号显示核实提醒', async ({ browser }) => {
    const { context, page } = await dingTalkPage(browser, 'ding-heqing')
    await page.goto(`${workbenchOrigin}/settings`)
    const section = page.getByRole('region', { name: '钉钉' })
    await expect(section).toContainText('管理员陈默代为绑定')
    await expect(section).toContainText('如果不是你本人的钉钉账号，请立即解除绑定并联系管理员')
    await context.close()
  })
})
