import { expect, test, type Page } from '@playwright/test'

// AMP-P0-01～03（e2e/catalog/admin-permissions.md）：模块管理员只看到有权限的菜单并直接进入自己的模块，
// 打开无权页面显示无权访问，只读管理员看到修改操作不可用。冒烟服务按测试 Cookie 切换身份。
const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

async function asAdmin(page: Page, identity: 'knowledge-admin' | 'reader') {
  await page.context().addCookies([{ name: 'dsh_test_admin_identity', value: identity, url: adminUrl }])
}

function navigation(page: Page) {
  return page.getByRole('navigation', { name: '管理后台主导航' })
}

test('AMP-P0-01 a module administrator only sees permitted menus and lands on its module', async ({ page }) => {
  await asAdmin(page, 'knowledge-admin')
  const failures: string[] = []
  page.on('response', (response) => {
    if (response.url().includes('/api/admin/v1/') && response.status() === 403) failures.push(response.url())
  })
  await page.goto(`${adminUrl}/`)
  await expect(page).toHaveURL(`${adminUrl}/knowledge`)
  await expect(page).toHaveTitle(/^企业知识库 · dsh-work$/)

  const menu = navigation(page)
  for (const name of ['管理助手', '企业知识库', '接入规范', '接口文档']) {
    await expect(menu.getByRole('button', { name, exact: true })).toBeVisible()
  }
  for (const name of ['运营概览', 'Agent 管理', '模型治理', '员工与权限', '钉钉集成', '系统健康', '审计记录']) {
    await expect(menu.getByRole('button', { name, exact: true })).toHaveCount(0)
  }
  await expect(menu.getByText('运行治理', { exact: true })).toHaveCount(0)
  await expect(page.getByText('修改操作已停用')).toHaveCount(0)
  expect(failures).toEqual([])
})

test('AMP-P0-02 opening a page of another module shows no access with a way back', async ({ page }) => {
  await asAdmin(page, 'knowledge-admin')
  await page.goto(`${adminUrl}/model-governance`)
  await expect(page.getByText('无权访问“模型”')).toBeVisible()
  await expect(page.getByText('你的账号没有查看权限')).toBeVisible()
  await page.getByRole('button', { name: '返回企业知识库' }).click()
  await expect(page).toHaveURL(`${adminUrl}/knowledge`)
})

test('AMP-P0-03 a read-only administrator sees why write actions are unavailable', async ({ page }) => {
  await asAdmin(page, 'reader')
  await page.goto(`${adminUrl}/knowledge`)
  await expect(page.getByText('你只有“查看企业知识库”权限，新建、编辑和删除等修改操作已停用。')).toBeVisible()
  await expect(page.getByRole('button', { name: '新建知识库' })).toHaveCount(0)
})
