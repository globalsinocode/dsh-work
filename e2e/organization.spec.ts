import { expect, test, type Page } from '@playwright/test'

// ORG-P0-01（e2e/catalog/organization.md）：管理端组织架构页直接进入部门树维护，
// 可新建部门、批量添加未分配员工、移出主部门时指定新主部门、删除被拦截。
// ORG-P0-02：部门授权页签（继承、添加、删除）与员工角色来源。
test.beforeEach(async ({ page }) => {
  await page.request.post('/api/testing/p0/reset')
})

const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

async function openOrganization(page: Page) {
  await page.goto(`${adminUrl}/overview`)
  await page.getByRole('navigation', { name: '管理后台主导航' }).getByRole('button', { name: '组织架构' }).click()
  await expect(page).toHaveURL(`${adminUrl}/organization`)
  return page.getByLabel('部门树')
}

async function selectDepartment(page: Page, name: string) {
  await page.getByLabel('部门树').getByText(name, { exact: true }).click()
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
}

test('administrator maintains the department tree and members', async ({ page }) => {
  const tree = await openOrganization(page)
  await expect(tree.getByText('供应链中心', { exact: true })).toBeVisible()
  const overview = page.getByRole('region', { name: '组织概况' })
  await expect(overview.getByText('未分配部门的员工')).toBeVisible()
  await expect(overview.getByText('部门本身不带权限')).toBeVisible()
  await page.getByRole('button', { name: /^查看含下级部门的 \d+ 名成员$/ }).click()
  await expect(page.getByRole('checkbox', { name: '包含下级部门成员' })).toBeChecked()

  await selectDepartment(page, '供应链中心')
  await expect(page.getByText('直属成员 2 人 · 含下级 5 人 · 下级部门 2 个')).toBeVisible()
  await expect(page.getByRole('cell', { name: /张伟/ })).toBeVisible()
  await expect(page.getByRole('cell', { name: /李娜/ })).toHaveCount(0)
  await page.getByText('包含下级部门成员', { exact: true }).click()
  await expect(page.getByRole('checkbox', { name: '包含下级部门成员' })).toBeChecked()
  await expect(page.getByRole('cell', { name: /李娜/ })).toBeVisible()

  await selectDepartment(page, '人力资源部')
  await page.getByRole('button', { name: '新建子部门' }).click()
  const nameDialog = page.getByRole('dialog', { name: '新建部门' })
  await nameDialog.getByLabel('部门名称').fill('招聘组')
  await nameDialog.getByRole('button', { name: '新建' }).click()
  await expect(page.getByText('已新建部门“招聘组”')).toBeVisible()
  await expect(tree.getByText('招聘组', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '新建子部门' }).click()
  await nameDialog.getByLabel('部门名称').fill('招聘组')
  await nameDialog.getByRole('button', { name: '新建' }).click()
  await expect(nameDialog.getByText('同一上级部门下已有同名部门')).toBeVisible()
  await nameDialog.getByRole('button', { name: '取消' }).click()

  await page.getByRole('button', { name: '添加成员' }).click()
  const addDialog = page.getByRole('dialog', { name: '添加成员到“人力资源部”' })
  await addDialog.getByText('只看未分配部门的员工', { exact: true }).click()
  await expect(addDialog.getByText('显示 3 人，已选 0 人')).toBeVisible()
  await addDialog.getByRole('button', { name: '全选当前列表' }).click()
  await addDialog.getByRole('button', { name: '添加（3）' }).click()
  await expect(page.getByText('已添加 3 名成员')).toBeVisible()
  await expect(page.getByText('直属成员 3 人')).toBeVisible()

  await page.getByRole('button', { name: '删除' }).click()
  await expect(page.getByText('不能删除“人力资源部”：还有 1 个下级部门，还有 3 名成员。')).toBeVisible()
  await page.getByRole('button', { name: '知道了' }).click()
})

test('removing a member from their primary department asks for a new primary department', async ({ page }) => {
  await openOrganization(page)
  await selectDepartment(page, '数字化中心')
  const row = page.getByRole('row', { name: /陈静/ })
  await expect(row.getByText('数字化中心 · 主部门')).toBeVisible()
  await row.getByRole('button', { name: '移出' }).click()
  const dialog = page.getByRole('dialog', { name: '移出部门' })
  await expect(dialog.getByText('新的主部门', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '移出' }).click()
  await expect(page.getByText('已将陈静移出“数字化中心”')).toBeVisible()
  await expect(page.getByRole('row', { name: /陈静/ })).toHaveCount(0)

  await selectDepartment(page, '供应链中心')
  await expect(page.getByRole('row', { name: /陈静/ }).getByText('供应链中心 · 主部门')).toBeVisible()
})

test('the root department cannot be moved or deleted and the page works at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${adminUrl}/organization`)
  await expect(page.getByRole('heading', { level: 2, name: '示例企业' })).toBeVisible()
  await expect(page.getByRole('button', { name: '移动' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '删除' })).toBeDisabled()
  const overflow = await page.evaluate(() => document.querySelector('.organization-layout')!.scrollWidth - document.querySelector('.organization-layout')!.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})

test('administrator grants a role to a department and sees where each role comes from', async ({ page }) => {
  await openOrganization(page)
  await selectDepartment(page, '采购部')
  await page.getByRole('tab', { name: /^部门授权/ }).click()
  const inherited = page.getByRole('row', { name: /供应链分析员/ })
  await expect(inherited.getByText('上级“供应链中心”')).toBeVisible()
  await expect(inherited.getByRole('button', { name: '到上级部门修改' })).toBeVisible()

  await page.getByRole('tab', { name: /^成员/ }).click()
  await page.getByRole('row', { name: /李娜/ }).getByRole('button', { name: '查看权限' }).click()
  const drawer = page.getByRole('dialog', { name: '员工部门与角色' })
  await expect(drawer.getByText('来自“示例企业 / 供应链中心”（下级继承）')).toBeVisible()
  await expect(drawer.getByText('直接授予', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  await selectDepartment(page, '财务部')
  await page.getByRole('tab', { name: /^部门授权/ }).click()
  await expect(page.getByText('本部门还没有授权，也没有从上级部门继承的授权')).toBeVisible()
  await page.getByRole('button', { name: '添加部门授权' }).click()
  const dialog = page.getByRole('dialog', { name: '添加部门授权' })
  await expect(dialog.getByRole('checkbox', { name: '包含所有下级部门' })).toBeChecked()
  await expect(dialog.getByText('将覆盖 1 名员工')).toBeVisible()
  await dialog.getByRole('button', { name: '授权' }).click()
  await expect(page.getByText('已授权，1 名员工的权限已重新计算')).toBeVisible()
  const granted = page.getByRole('row', { name: /员工/ }).filter({ hasText: '本部门及下级' })
  await expect(granted).toBeVisible()

  await granted.getByRole('button', { name: '删除' }).click()
  await page.getByRole('dialog', { name: '删除部门授权' }).getByRole('button', { name: '删除' }).click()
  await expect(page.getByText('已删除部门授权')).toBeVisible()
  await expect(page.getByText('本部门还没有授权，也没有从上级部门继承的授权')).toBeVisible()
})

