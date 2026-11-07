import type { KnowledgeGrant } from '@/types/knowledge'

/** 2026-10-28T09:30:00Z → 2026-10-28（按浏览器本地时区）。 */
export function formatKnowledgeDate(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatKnowledgeDateTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${formatKnowledgeDate(value)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** “计划组（含下级）、财务部”：上传与授权变更前提示的可见部门（WK13）。 */
export function describeKnowledgeGrants(grants: KnowledgeGrant[]): string {
  if (!grants.length) return '无可见部门'
  return grants
    .map(grant => grant.departmentName + (grant.includeDescendants && grant.departmentName !== '全公司' ? '（含下级）' : ''))
    .join('、')
}
