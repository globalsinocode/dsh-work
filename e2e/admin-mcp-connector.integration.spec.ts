import { randomUUID } from 'node:crypto'
import { expect, test, type APIResponse } from '@playwright/test'

async function data<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()).data as T
}

test('PF-MCP-01: one Connector is the review and Agent authorization boundary', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8)
  const connectorName = `P1 CRM MCP ${suffix}`
  const initialToken = `p1-initial-${suffix}`

  await page.goto('/connectors')
  await page.getByRole('button', { name: '新增 MCP', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: '新增 MCP Connector' })
  await createDialog.getByLabel('连接器名称').fill(connectorName)
  await createDialog.getByLabel('Streamable HTTP 地址').fill('https://mcp.example.test/rpc')
  await createDialog.locator('.el-radio').filter({ hasText: 'Bearer Token' }).click()
  await createDialog.getByLabel('Bearer Token', { exact: true }).last().fill(initialToken)
  await createDialog.getByLabel('整体权限范围').fill('P1 合成客户主数据，只读范围')
  await createDialog.getByRole('button', { name: '登记并发现', exact: true }).click()

  const row = page.getByRole('row').filter({ hasText: connectorName })
  await expect(row).toContainText('待审核')
  await expect(row).toContainText('2 个 Tool')
  const connectors = await data<Array<{ id: string; name: string }>>(
    await page.request.get('/api/admin/v1/connectors'),
  )
  const connectorId = connectors.find(item => item.name === connectorName)?.id
  expect(connectorId).toMatch(/^connector-mcp-/)

  await row.getByRole('button', { name: '轮换 Token', exact: true }).click()
  const rotateDialog = page.getByRole('dialog', { name: `轮换 Bearer Token · ${connectorName}` })
  await rotateDialog.getByLabel('新 Bearer Token').fill(`p1-rotated-${suffix}`)
  await rotateDialog.getByRole('button', { name: '轮换并检查', exact: true }).click()
  await expect(row).toContainText('待审核')
  await row.getByRole('button', { name: '查看', exact: true }).click()
  const detail = page.locator('.el-drawer').filter({ hasText: connectorName })
  await expect(detail).toContainText('读取一个客户')
  await expect(detail).toContainText('输入 Schema')
  await expect(detail).toContainText('"id"')
  await page.keyboard.press('Escape')
  await row.getByRole('button', { name: '整体审核', exact: true }).click()
  const approveDialog = page.getByRole('dialog', { name: `审核通过“${connectorName}”？` })
  await expect(approveDialog).toContainText('2 个 Tool 作为一个整体授权边界')
  await expect(approveDialog).toContainText('customer_get')
  await expect(approveDialog).toContainText('读取一个客户')
  await expect(approveDialog).toContainText('"id"')
  await approveDialog.getByRole('button', { name: '审核通过', exact: true }).click()
  await expect(row).toContainText('已审核')

  await row.getByRole('button', { name: 'Agent 权限', exact: true }).click()
  let accessDialog = page.getByRole('dialog', { name: `Agent 权限 · ${connectorName}` })
  await expect(accessDialog).toContainText('这里不提供单 Tool 授权')
  const accessSwitch = accessDialog.getByRole('switch', { name: 'dsh-work 助手 MCP 权限' })
  await accessSwitch.locator('..').click()
  await expect(accessSwitch).toBeChecked()

  let evidence = await data<{ platformToolCount: number; activeGrantCount: number }>(
    await page.request.get(`/api/admin/v1/test/mcp/evidence?connector_id=${encodeURIComponent(connectorId!)}`),
  )
  expect(evidence).toEqual({ platformToolCount: 0, activeGrantCount: 1 })
  await accessDialog.getByRole('button', { name: '完成', exact: true }).click()

  await data(await page.request.post('/api/admin/v1/test/mcp/capabilities', { data: { changed: true } }))
  await row.getByRole('button', { name: '发现', exact: true }).click()
  await expect(row).toContainText('变更待审')
  await expect(row).toContainText('3 个 Tool')
  await row.getByRole('button', { name: 'Agent 权限', exact: true }).click()
  accessDialog = page.getByRole('dialog', { name: `Agent 权限 · ${connectorName}` })
  const revocableGrant = accessDialog.getByRole('switch', { name: 'dsh-work 助手 MCP 权限' })
  await expect(revocableGrant).toBeChecked()
  await expect(revocableGrant).toBeEnabled()
  await revocableGrant.locator('..').click()
  await expect(revocableGrant).not.toBeChecked()
  evidence = await data(await page.request.get(
    `/api/admin/v1/test/mcp/evidence?connector_id=${encodeURIComponent(connectorId!)}`,
  ))
  expect(evidence).toEqual({ platformToolCount: 0, activeGrantCount: 0 })
  await accessDialog.getByRole('button', { name: '完成', exact: true }).click()

  await row.getByRole('button', { name: '整体审核', exact: true }).click()
  const reapproveDialog = page.getByRole('dialog', { name: `审核通过“${connectorName}”？` })
  await expect(reapproveDialog).toContainText('3 个 Tool 作为一个整体授权边界')
  await expect(reapproveDialog).toContainText('customer_export')
  await expect(reapproveDialog).toContainText('导出客户')
  await reapproveDialog.getByRole('button', { name: '审核通过', exact: true }).click()
  await expect(row).toContainText('已审核')

  await row.getByRole('button', { name: 'Agent 权限', exact: true }).click()
  accessDialog = page.getByRole('dialog', { name: `Agent 权限 · ${connectorName}` })
  const restoredGrant = accessDialog.getByRole('switch', { name: 'dsh-work 助手 MCP 权限' })
  await expect(restoredGrant).not.toBeChecked()
  await expect(restoredGrant).toBeEnabled()
  await restoredGrant.locator('..').click()
  await expect(restoredGrant).toBeChecked()
  evidence = await data(await page.request.get(
    `/api/admin/v1/test/mcp/evidence?connector_id=${encodeURIComponent(connectorId!)}`,
  ))
  expect(evidence).toEqual({ platformToolCount: 0, activeGrantCount: 1 })
  await accessDialog.getByRole('button', { name: '完成', exact: true }).click()

  await row.getByRole('button', { name: '停用', exact: true }).click()
  await page.getByRole('dialog', { name: `停用“${connectorName}”？` })
    .getByRole('button', { name: '确认停用', exact: true }).click()
  await expect(row).toContainText('已停用')
  await row.getByRole('button', { name: '发现', exact: true }).click()
  await expect(row).toContainText('已停用')
  await expect(page.getByText(`${connectorName}检查完成，仍保持人工停用；需要恢复时请显式启用`, { exact: true })).toBeVisible()

  await data(await page.request.post('/api/admin/v1/test/mcp/capabilities', { data: { changed: false } }))
  await row.getByRole('button', { name: '发现', exact: true }).click()
  await expect(row).toContainText('已停用')
  await expect(row).toContainText('变更待审')
  await row.getByRole('button', { name: '整体审核', exact: true }).click()
  await page.getByRole('dialog', { name: `审核通过“${connectorName}”？` })
    .getByRole('button', { name: '审核通过', exact: true }).click()
  await expect(row).toContainText('已停用')
  await expect(row).toContainText('已审核')

  await row.getByRole('button', { name: 'Agent 权限', exact: true }).click()
  accessDialog = page.getByRole('dialog', { name: `Agent 权限 · ${connectorName}` })
  const disabledConnectorGrant = accessDialog.getByRole('switch', { name: 'dsh-work 助手 MCP 权限' })
  await expect(disabledConnectorGrant).toBeChecked()
  await expect(disabledConnectorGrant).toBeEnabled()
  await disabledConnectorGrant.locator('..').click()
  await expect(disabledConnectorGrant).not.toBeChecked()
  await accessDialog.getByRole('button', { name: '完成', exact: true }).click()

  await row.getByRole('button', { name: '启用', exact: true }).click()
  await page.getByRole('dialog', { name: `启用“${connectorName}”？` })
    .getByRole('button', { name: '确认启用', exact: true }).click()
  await expect(row).toContainText('正常')
})
