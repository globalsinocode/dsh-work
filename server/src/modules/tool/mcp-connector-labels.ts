import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'

/**
 * 执行准备拒绝时用于向员工说明「为什么这位 AI 同事不可用」。
 *
 * 选定的 Connector 不可用时，原来的提示只给出租户内无法辨认的 UUID；员工和运维
 * 都不知道该找哪个连接器。这里补上连接器名称，名称缺失时保留标识，确保信息不丢。
 */
export async function describeUnavailableMcpConnectors(
  database: DatabaseClient,
  tenantId: string,
  connectorIds: readonly string[],
): Promise<string> {
  if (!connectorIds.length) return ''
  const rows = await database<Array<{ id: string; name: string }>>`
    select id, name from connectors
     where tenant_id = ${tenantId} and id = any(${[...connectorIds]})
  `
  const names = new Map(rows.map(row => [row.id, row.name]))
  return connectorIds
    .map(id => {
      const name = names.get(id)
      return name ? `${name}（${id}）` : id
    })
    .join('、')
}

/**
 * 403 的通用建议是「联系管理员配置角色与数据范围」，但连接器不可用时问题不在账号权限。
 * 这条建议随错误一起返回，避免员工被引到错误的自助处理路径。
 */
export const MCP_CONNECTOR_UNAVAILABLE_SUGGESTION =
  '请联系管理员恢复该 AI 同事依赖的 MCP Connector（检查启用状态、端点与凭据）；恢复前请改用不依赖该连接器的 AI 同事。'
