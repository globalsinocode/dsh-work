import { randomUUID } from 'node:crypto'
import { expect, test, type APIResponse } from '@playwright/test'

async function data<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()).data as T
}

test('PF-MCP-01: Connector registration and capability changes take effect automatically', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8)
  const connectorName = `P1 CRM MCP ${suffix}`
  const initialToken = `p1-initial-${suffix}`

  await page.goto('/connectors')
  await page.getByRole('button', { name: '新增 MCP', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: '新增 MCP Connector' })
  await createDialog.getByLabel('连接器名称').fill(connectorName)
  await createDialog.getByLabel('Streamable HTTP 地址').fill('https://auth-required.example.test/rpc')
  await createDialog.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect(createDialog.getByText('认证失败', { exact: true })).toBeVisible()
  await expect(createDialog).toContainText('MCP 认证失败：该服务要求 Bearer Token')
  await createDialog.getByLabel('Streamable HTTP 地址').fill('https://mcp.example.test/rpc')
  await createDialog.locator('.el-radio').filter({ hasText: 'Bearer Token' }).click()
  await createDialog.getByLabel('Bearer Token', { exact: true }).last().fill(initialToken)
  await createDialog.getByLabel('整体权限范围').fill('P1 合成客户主数据，只读范围')
  const addMcpButton = createDialog.getByRole('button', { name: '添加 MCP', exact: true })
  await expect(addMcpButton).toBeDisabled()
  await createDialog.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect(createDialog.getByText('连通测试成功：5 ms，发现 2 个 Tool', { exact: true })).toBeVisible()
  await expect(addMcpButton).toBeEnabled()
  await createDialog.getByLabel('Streamable HTTP 地址').fill('https://mcp.example.test/changed')
  await expect(addMcpButton).toBeDisabled()
  await createDialog.getByLabel('Streamable HTTP 地址').fill('https://mcp.example.test/rpc')
  await expect(addMcpButton).toBeDisabled()
  await createDialog.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect(addMcpButton).toBeEnabled()
  await addMcpButton.click()

  const row = page.getByRole('row').filter({ hasText: connectorName })
  const chooseMoreAction = async (label: string) => {
    await row.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }
  await expect(row).toContainText('已生效')
  await expect(row.getByRole('button', { name: '2 个', exact: true })).toBeVisible()
  await row.getByRole('button', { name: '2 个', exact: true }).click()
  const toolsDialog = page.getByRole('dialog', { name: `工具清单 · ${connectorName}` })
  await expect(toolsDialog).toContainText('customer_get')
  await expect(toolsDialog).toContainText('读取一个客户')
  await expect(toolsDialog).toContainText('"id"')
  await toolsDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('button', { name: '整体审核', exact: true })).toHaveCount(0)
  const connectors = await data<Array<{ id: string; name: string }>>(
    await page.request.get('/api/admin/v1/connectors'),
  )
  const connectorId = connectors.find(item => item.name === connectorName)?.id
  expect(connectorId).toMatch(/^connector-mcp-/)

  await chooseMoreAction('轮换 Token')
  const rotateDialog = page.getByRole('dialog', { name: `轮换 Bearer Token · ${connectorName}` })
  await rotateDialog.getByLabel('新 Bearer Token').fill(`p1-rotated-${suffix}`)
  await rotateDialog.getByRole('button', { name: '轮换并检查', exact: true }).click()
  await expect(page.getByText(`${connectorName}检查通过，2 个 Tool 已同步生效`, { exact: true })).toBeVisible()
  await expect(row).toContainText('已生效')
  await row.getByRole('button', { name: '查看', exact: true }).click()
  const detail = page.locator('.el-drawer').filter({ hasText: connectorName })
  await expect(detail).toContainText('读取一个客户')
  await expect(detail).toContainText('输入 Schema')
  await expect(detail).toContainText('"id"')
  await expect(detail).toContainText('适用 Agent')
  await expect(detail).toContainText('全部 Agent')
  await page.keyboard.press('Escape')
  await row.getByRole('button', { name: '更多', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Agent 权限', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')

  let evidence = await data<{ platformToolCount: number; resolvedConnectionCount: number }>(
    await page.request.get(`/api/admin/v1/test/mcp/evidence?connector_id=${encodeURIComponent(connectorId!)}`),
  )
  expect(evidence).toEqual({ platformToolCount: 0, resolvedConnectionCount: 1 })

  await data(await page.request.post('/api/admin/v1/test/mcp/capabilities', { data: { changed: true } }))
  await row.getByRole('button', { name: '检查', exact: true }).click()
  await expect(page.getByText(`${connectorName}检查通过，3 个 Tool 已同步生效`, { exact: true })).toBeVisible()
  await expect(row).toContainText('已生效')
  await expect(row).toContainText('3')
  evidence = await data(await page.request.get(
    `/api/admin/v1/test/mcp/evidence?connector_id=${encodeURIComponent(connectorId!)}`,
  ))
  expect(evidence).toEqual({ platformToolCount: 0, resolvedConnectionCount: 1 })

  await chooseMoreAction('停用')
  await page.getByRole('dialog', { name: `停用“${connectorName}”？` })
    .getByRole('button', { name: '确认停用', exact: true }).click()
  await expect(row).toContainText('已停用')
  await row.getByRole('button', { name: '检查', exact: true }).click()
  await expect(row).toContainText('已停用')
  await expect(page.getByText(`${connectorName}检查完成，仍保持人工停用；需要恢复时请显式启用`, { exact: true })).toBeVisible()

  await data(await page.request.post('/api/admin/v1/test/mcp/capabilities', { data: { changed: false } }))
  await row.getByRole('button', { name: '检查', exact: true }).click()
  await expect(row).toContainText('已停用')
  evidence = await data(await page.request.get(
    `/api/admin/v1/test/mcp/evidence?connector_id=${encodeURIComponent(connectorId!)}`,
  ))
  expect(evidence).toEqual({ platformToolCount: 0, resolvedConnectionCount: 0 })

  await chooseMoreAction('启用')
  await page.getByRole('dialog', { name: `启用“${connectorName}”？` })
    .getByRole('button', { name: '确认启用', exact: true }).click()
  await expect(row).toContainText('已生效')
  evidence = await data(await page.request.get(
    `/api/admin/v1/test/mcp/evidence?connector_id=${encodeURIComponent(connectorId!)}`,
  ))
  expect(evidence).toEqual({ platformToolCount: 0, resolvedConnectionCount: 1 })

  await chooseMoreAction('删除')
  const deleteDialog = page.getByRole('dialog', { name: `删除“${connectorName}”？` })
  await expect(deleteDialog).toContainText('立即停止所有 Agent 使用该连接器')
  await deleteDialog.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(row).toHaveCount(0)
  const deletionEvidence = await data<{
    deleted: boolean; credentialDetached: boolean; profileCount: number; resolvedConnectionCount: number
  }>(await page.request.get(
    `/api/admin/v1/test/mcp/deletion-evidence?connector_id=${encodeURIComponent(connectorId!)}`,
  ))
  expect(deletionEvidence).toEqual({
    deleted: true,
    credentialDetached: true,
    profileCount: 1,
    resolvedConnectionCount: 0,
  })
})
