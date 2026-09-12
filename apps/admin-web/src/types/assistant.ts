export interface InstalledSkillPackage {
  name: string
  description: string
  instructions: string
  version: string | null
  toolIds: string[]
  sha256: string
  archiveSha256: string
  files: Array<{ path: string; size: number; sha256: string }>
}
export interface SkillInstallation {
  id: string
  runId: string
  source: string
  resolvedUrl: string | null
  resolvedRef: string | null
  status: 'pending' | 'installed' | 'cancelled'
  skillId: string | null
  package: InstalledSkillPackage | null
}
export interface AdminConversation {
  id: string
  title: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; runId: string }>
  runs: Array<{ id: string; status: 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled'; error: string | null }>
  installations: SkillInstallation[]
}
