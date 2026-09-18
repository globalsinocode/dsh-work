export interface InstalledSkillPackage {
  name: string
  description: string
  instructions: string
  version: string | null
  toolIds: string[]
  sha256: string
  archiveSha256: string
  files: Array<{ path: string; size: number; sha256: string }>
  requirements: Array<{ type: 'skill' | 'tool' | 'python' | 'external'; name: string; status: 'resolved' | 'missing' | 'unsupported' | 'needs_review'; evidence: string }>
  compatibility: SkillCompatibility
  disableModelInvocation: boolean
}
export interface SkillCompatibility {
  status: 'compatible' | 'needs_review' | 'incompatible'
  issues: Array<{ code: string; severity: 'warning' | 'error'; message: string }>
}
export interface SkillInstallationPlan {
  planVersion: '1.0'
  rootName: string
  packages: InstalledSkillPackage[]
  edges: Array<{ from: string; to: string; type: 'skill' }>
  compatibility: SkillCompatibility
  summary: { packageCount: number; dependencyCount: number; toolIds: string[]; pythonFiles: number }
  sha256: string
}
export interface SkillInstallation {
  id: string
  runId: string | null
  source: string
  resolvedUrl: string | null
  resolvedRef: string | null
  status: 'pending' | 'installed' | 'cancelled'
  skillId: string | null
  resultType: 'created' | 'updated' | 'duplicate' | null
  installedVersion: string | null
  package: InstalledSkillPackage | null
  plan: SkillInstallationPlan | null
  planSha256: string | null
  compatibilityStatus: SkillCompatibility['status'] | null
}
export interface AdminConversation {
  id: string
  title: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; runId: string }>
  runs: Array<{ id: string; status: 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled'; error: string | null }>
  installations: SkillInstallation[]
  proposals: AdminTaskProposal[]
  actions: AdminActionPlan[]
}

export interface AdminTaskProposal {
  id: string
  runId: string
  kind: 'skill-install' | 'agent-management' | 'platform-operations'
  title: string
  assistantName: string
  purpose: 'admin-skill-install' | 'admin-agent-manage' | 'admin-platform-operations'
  request: string
  impact: string
  proposalSha256: string
  status: 'pending' | 'confirmed' | 'cancelled'
  delegatedRunId: string | null
}

export interface AdminActionPlan {
  id: string
  runId: string
  actionType: 'agent-update-draft' | 'agent-set-status' | 'runtime-update-configuration'
  summary: string
  confirmationMode?: 'single' | 'delegated'
  before: Record<string, unknown>
  after: Record<string, unknown>
  planSha256: string
  status: 'pending' | 'executing' | 'executed' | 'cancelled' | 'failed'
  resultSummary: string | null
}
