import type { WorkspaceFile, WorkspaceFileVersion } from '@/types/domain'

/**
 * 版本解析状态文案（design §4：状态不靠颜色传达）。服务端闭集之外的脏数据
 * 返回中性文案，绝不渲染空白行。
 */
export function describeVersionParseStatus(parseStatus: string): string {
  if (parseStatus === 'succeeded') return '解析成功'
  if (parseStatus === 'failed') return '解析失败'
  if (parseStatus === 'pending') return '处理中'
  return '状态未知'
}

/**
 * 只有「服务端判定可下载」且「解析成功」的版本才允许引用到对话：失败版本仍会
 * 保留在版本列表里（AC-13 可追溯），但不进入新引用。
 */
export function canReferenceVersion(
  version: Pick<WorkspaceFileVersion, 'canDownload' | 'parseStatus'>,
): boolean {
  return version.canDownload === true && version.parseStatus === 'succeeded'
}

/**
 * 把某个版本转成 `ConversationStarter.useWorkspaceFile` 需要的文件对象。引用必须
 * 固定到该版本的不可变对象 id（TW-07：历史 Run 由此可追溯实际输入版本），因此
 * `id` 取版本的 `fileId`，而不是逻辑文件 id。
 */
export function toVersionFileReference(version: WorkspaceFileVersion): WorkspaceFile {
  return {
    id: version.fileId,
    name: version.name,
    type: version.type,
    size: version.size,
    uploadedBy: version.uploadedBy,
    uploadedAt: version.uploadedAt,
    logicalFileId: version.logicalFileId,
    // 版本引用与文件行同一道服务端门控（评审低1）：WorkspaceDetailView 对
    // 团队文件要求显式 canReference，否则 useWorkspaceFile 直接拒绝。
    canReference: canReferenceVersion(version),
  }
}

/**
 * 文件行的版本标记：仅当服务端给出正整数版本号时渲染；版本总数多于一个时补
 * 「共 N 个版本」。个人空间文件与历史夹具没有这些字段，返回空串表示不渲染。
 */
/** 服务端 `version_no`/`count(*)::integer` 的取值范围（PostgreSQL integer）。 */
const MAX_VERSION_NO = 2_147_483_647

export function formatFileVersionLabel(file: Pick<WorkspaceFile, 'versionNo' | 'versionCount'>): string {
  const versionNo = file.versionNo
  // `Number.isInteger(1e21)` 为真，直接渲染会得到 `V1e+21`：用安全整数 + 服务端
  // integer 上限双重约束（规格评审 nit；真实后端不可达，但契约外的脏数据不该上屏）。
  if (!isServerVersionNumber(versionNo)) return ''
  const count = file.versionCount
  if (isServerVersionNumber(count) && count > 1) {
    return `V${versionNo} · 共 ${count} 个版本`
  }
  return `V${versionNo}`
}

function isServerVersionNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_VERSION_NO
}
