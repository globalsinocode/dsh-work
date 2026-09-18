import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'

// Real temporary PostgreSQL and HTTP APIs; explicitly synthetic Runtime/identity.
// No route interception, production credentials or direct writes from the browser.
async function fixtures(page: import('@playwright/test').Page) {
  const response = await page.request.get('/api/workbench/v1/test/fixtures')
  expect(response.ok()).toBeTruthy()
  const data = (await response.json()).data
  expect(data.synthetic).toBe(true)
  return data
}

test('P1: complete history resolves old Runs and resumes an empty Session without moving it', async ({ page }) => {
  const seed = await fixtures(page)
  await page.goto('/history')
  await page.getByLabel('搜索对话标题').fill('P1-旧对话')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('button', { name: /P1-旧对话-需要恢复/ }).click()
  await expect(page).toHaveURL(/\/conversations\/run-/)
  await expect(page.getByLabel('对话输入')).toBeVisible()
  await page.goto(`/sessions/${seed.emptySessionId}`)
  await expect(page.getByText('这段对话尚未开始任务。继续发送会沿用原对话，不创建另一个会话。')).toBeVisible()
  await page.getByLabel('对话输入').fill('P1-继续原空会话')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText(/受控测试运行已完成/).first()).toBeVisible()
  const resumed = await page.request.get(`/api/workbench/v1/sessions/${seed.emptySessionId}`)
  const row = (await resumed.json()).data
  expect(row.runCount).toBe(1); expect(row.workspaceId).toBe(seed.personalId)
})

test('P1: upload, reference, download and logical removal retain the underlying personal ownership', async ({ page }) => {
  const seed = await fixtures(page), name = `P1-材料-${randomUUID()}.txt`, prompt = `P1-引用-${randomUUID()}`
  await page.goto('/files')
  await page.getByLabel('上传个人材料').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('P1 synthetic personal input') })
  const row = page.getByRole('listitem').filter({ hasText: name })
  await expect(row).toHaveCount(1)
  const downloadPromise = page.waitForEvent('download')
  await row.getByRole('button', { name: '下载', exact: true }).click()
  expect((await downloadPromise).suggestedFilename()).toBe(name)
  await row.getByRole('button', { name: '引用到新对话', exact: true }).click()
  await expect(page).toHaveURL(/\/workbench\?file=/)
  await page.getByLabel('对话输入').fill(prompt)
  const createdRequest = page.waitForRequest(r => r.method()==='POST' && new URL(r.url()).pathname==='/api/workbench/v1/sessions')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  expect((await createdRequest).postDataJSON()).not.toHaveProperty('workspaceId')
  await expect(page.getByText(/受控测试运行已完成.*输入文件 1 个/).first()).toBeVisible()
  const list = await page.request.get(`/api/workbench/v1/sessions?query=${encodeURIComponent(prompt)}`)
  expect((await list.json()).data.items[0].workspaceId).toBe(seed.personalId)
  await page.goto(`/files?q=${encodeURIComponent(name)}`)
  const id = (await (await page.request.get(`/api/workbench/v1/files?query=${encodeURIComponent(name)}`)).json()).data.items[0].id
  await row.getByRole('button', { name: '移除', exact: true }).click()
  await page.getByRole('button', { name: '移除文件', exact: true }).click()
  await expect(row).toHaveCount(0)
  expect((await page.request.get(`/api/workbench/v1/files/${id}/download`)).status()).toBe(403)
})

test('P1: removing a conversation retains attachments and marks the removed source', async ({ page }) => {
  const title=`P1-移除-${randomUUID()}`, name=`${title}.txt`
  const created=await page.request.post('/api/workbench/v1/sessions',{data:{title}})
  expect(created.status()).toBe(201)
  const session=(await created.json()).data
  const uploaded=await page.request.post(`/api/workbench/v1/sessions/${session.id}/files`,{data:Buffer.from('P1 retained attachment'),headers:{'content-type':'text/plain','x-file-name':encodeURIComponent(name)}})
  expect(uploaded.status()).toBe(201)
  await page.goto(`/history?q=${encodeURIComponent(title)}`)
  await page.getByRole('button',{name:`移除对话：${title}`,exact:true}).click()
  await page.getByRole('button',{name:'移除对话',exact:true}).click()
  await expect(page.getByText('没有匹配的对话',{exact:true})).toBeVisible()
  await page.goto(`/files?q=${encodeURIComponent(name)}`)
  const row=page.getByRole('listitem').filter({hasText:name})
  await expect(row).toContainText('会话附件');await expect(row).toContainText('原对话已移除，文件独立保留')
  await expect(row.getByRole('link',{name:'来源对话'})).toHaveCount(0)
  const policy=await page.request.get('/api/workbench/v1/content-policy')
  expect((await policy.json()).data.physicalDeletion).toBe(false)
})

test('P1: legacy links are authorized and an explicit invalid team never falls back to personal', async ({ page }) => {
  const seed=await fixtures(page)
  await page.goto(`/workspaces/${seed.personalId}?tab=artifacts`)
  await expect(page).toHaveURL(/\/files\?source=artifact$/)
  await expect(page.getByText('P1-合成成果.txt',{exact:true})).toBeVisible()
  await page.goto('/workspaces/ws-personal-U00008')
  await expect(page.getByText('工作空间不存在或你没有访问权限',{exact:true})).toBeVisible()
  const bad=await page.request.post('/api/workbench/v1/sessions',{data:{title:'no fallback',workspaceId:'missing-team'}})
  expect(bad.status()).toBe(403)
  await page.getByRole('navigation',{name:'员工工作台主导航'}).getByRole('button',{name:'新对话',exact:true}).click()
  await expect(page.getByLabel('当前工作空间')).toHaveCount(0)
  await expect(page.getByLabel('选择工作空间')).toHaveCount(0)
  await page.setViewportSize({width:390,height:844})
  await page.goto('/files')
  await expect(page.getByRole('heading',{name:'我的文件',exact:true})).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})
