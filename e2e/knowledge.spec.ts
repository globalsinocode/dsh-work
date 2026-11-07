import { expect, test, type Page } from '@playwright/test'

// KB-P0-01、KB-P0-02（e2e/catalog/knowledge.md）：P0 冒烟服务的内存知识库，测试身份属于计划组（主）与采购组。
// 可见范围、WeKnora 转发与审计由 server/src/http/knowledge-api.integration.test.ts 覆盖。

async function useLevel(page: Page, level: 'view' | 'docs' | 'bases') {
  const response = await page.request.post('/api/testing/p0/knowledge-level', { data: { level } })
  expect(response.ok()).toBe(true)
}

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/testing/p0/reset')
})

test('KB-P0-01: 知识库列表与详情按项目空间布局展示', async ({ page }) => {
  await page.goto('/workbench')
  const navigation = page.getByRole('navigation', { name: '员工工作台主导航' })
  await navigation.getByRole('button', { name: '知识库' }).click()
  await expect(page).toHaveURL(/\/knowledge$/)
  await expect(page.getByRole('heading', { name: '知识库', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^打开知识库/ })).toHaveCount(3)
  await expect(page.getByText('3 个可查看的知识库')).toBeVisible()

  await page.getByRole('button', { name: '可管理' }).click()
  await expect(page.getByRole('button', { name: /^打开知识库/ })).toHaveCount(1)
  await page.getByRole('button', { name: '全部' }).click()
  await page.getByLabel('搜索知识库名称或归属部门').fill('供应链')
  await expect(page.getByRole('button', { name: /^打开知识库/ })).toHaveCount(1)
  await page.getByLabel('搜索知识库名称或归属部门').fill('')

  await page.getByRole('button', { name: '打开知识库 计划组工作手册' }).click()
  await expect(page).toHaveURL(/\/knowledge\/kb-plan$/)
  const crumbs = page.getByRole('navigation', { name: '当前位置' })
  await expect(crumbs.getByRole('link', { name: '知识库' })).toBeVisible()
  await expect(crumbs.getByText('计划组工作手册')).toBeVisible()
  await expect(page.getByRole('cell', { name: '补货会议规则', exact: true })).toBeVisible()
  await expect(page.getByRole('row', { name: /旧版补货口径/ }).getByText('解析失败')).toBeVisible()
  const info = page.getByRole('complementary', { name: '知识库信息' })
  await expect(info.getByText('知识库管理')).toBeVisible()
  await expect(info.getByText('管理员授予')).toBeVisible()

  await page.getByRole('button', { name: '解析中' }).click()
  await expect(page.getByRole('cell', { name: '排产计划模板说明', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: '补货会议规则', exact: true })).toHaveCount(0)
})

test('KB-P0-01: 三种权限看到不同的操作', async ({ page }) => {
  await useLevel(page, 'view')
  await page.goto('/knowledge')
  await expect(page.getByRole('heading', { name: '知识库', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建知识库' })).toHaveCount(0)
  await page.goto('/knowledge/kb-plan')
  await expect(page.getByRole('cell', { name: '补货会议规则', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '上传文件' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^更多操作/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '管理可见部门' })).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: '知识库信息' }).getByText('仅查看')).toBeVisible()

  await useLevel(page, 'docs')
  await page.reload()
  await expect(page.getByRole('button', { name: '上传文件' })).toBeVisible()
  await expect(page.getByRole('button', { name: '管理可见部门' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '删除知识库' })).toHaveCount(0)
  // 可见但归属其他部门的知识库只能查看。
  await page.goto('/knowledge/kb-supply')
  await expect(page.getByRole('cell', { name: '委外加工业务管理办法', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '上传文件' })).toHaveCount(0)

  await useLevel(page, 'bases')
  await page.goto('/knowledge/kb-plan')
  await expect(page.getByRole('button', { name: '管理可见部门' })).toBeVisible()
  await expect(page.getByRole('button', { name: '删除知识库' })).toBeVisible()
})

test('KB-P0-01: 新建知识库、调整可见部门与删除', async ({ page }) => {
  await page.goto('/knowledge')
  await page.getByRole('button', { name: '新建知识库' }).click()
  const createDialog = page.getByRole('dialog', { name: '新建知识库' })
  await createDialog.getByLabel('名称').fill('采购组作业规范')
  await expect(createDialog.getByText('计划组及其下级部门')).toBeVisible()
  await expect(createDialog.getByText('权限不同的文档请放在不同的知识库里')).toBeVisible()
  await createDialog.getByRole('button', { name: '创建' }).click()
  await expect(page).toHaveURL(/\/knowledge\/kb-new-/)
  await expect(page.getByText('还没有文档')).toBeVisible()

  await page.getByRole('button', { name: '管理可见部门' }).click()
  const grantDialog = page.getByRole('dialog', { name: '可见部门' })
  await expect(grantDialog.getByText('你只能授给自己所属的部门')).toBeVisible()
  await grantDialog.getByRole('button', { name: '添加' }).click()
  await expect(grantDialog.getByText('当前可见部门：计划组（含下级）、采购组（含下级）')).toBeVisible()
  await grantDialog.getByRole('button', { name: '撤销采购组' }).click()
  await expect(grantDialog.getByText('当前可见部门：计划组（含下级）')).toBeVisible()
  await grantDialog.getByRole('button', { name: '完成' }).click()

  await page.getByRole('button', { name: '删除知识库' }).click()
  const confirm = page.getByRole('dialog', { name: '删除“采购组作业规范”' })
  await confirm.getByRole('textbox').fill('采购组作业规范')
  await confirm.getByRole('button', { name: '删除' }).click()
  await expect(page).toHaveURL(/\/knowledge$/)
  await expect(page.getByRole('button', { name: '打开知识库 采购组作业规范' })).toHaveCount(0)
})

test('KB-P0-02: 对话中添加与移除知识库', async ({ page }) => {
  await page.goto('/knowledge/kb-plan')
  await page.getByRole('button', { name: '用这个知识库提问' }).click()
  await expect(page).toHaveURL(/\/workbench\?.*knowledgeBase=kb-plan/)
  const chips = page.getByLabel('本对话检索的知识库')
  await expect(chips.getByText('计划组工作手册')).toBeVisible()

  await page.getByRole('button', { name: '添加知识库' }).click()
  const picker = page.getByRole('dialog', { name: '添加知识库' })
  await expect(picker.getByRole('checkbox', { name: '计划组工作手册' })).toBeChecked()
  // Element Plus 隐藏原生复选框，点击可见的标签文字。
  await picker.getByText('供应链制度库', { exact: true }).click()
  await expect(picker.getByRole('checkbox', { name: '供应链制度库' })).toBeChecked()
  await picker.getByRole('button', { name: '确定' }).click()
  await expect(chips.getByText('供应链制度库')).toBeVisible()

  await page.getByRole('button', { name: '移除知识库 计划组工作手册' }).click()
  await expect(chips.getByText('计划组工作手册')).toHaveCount(0)
  await expect(chips.getByText('供应链制度库')).toBeVisible()

  // 一期团队空间不提供添加入口。
  await page.goto('/workspaces/ws-supply?tab=conversation')
  await expect(page.getByLabel('对话输入')).toBeVisible()
  await expect(page.getByRole('button', { name: '添加知识库' })).toHaveCount(0)

  // B 协作模式：主导航有“知识库”，单聊输入框同样可以添加知识库。
  await page.goto('/workbench')
  await page.getByRole('button', { name: '切换模式' }).click()
  await page.getByRole('menuitem', { name: /协作模式/ }).click()
  await expect(page).toHaveURL(/\/c\/chats$/)
  await expect(page.getByRole('navigation', { name: '协作模式主导航' }).getByRole('button', { name: '知识库' })).toBeVisible()
  await page.goto('/c/chats/agent/dsh-work-assistant')
  await expect(page.getByRole('button', { name: '添加知识库' })).toBeVisible()
})
