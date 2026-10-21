import type { InjectionKey, Ref } from 'vue'

/** 底栏提交负载，与 TaskComposer submit 一致（不含 contextKey）。 */
export interface TeamComposerSubmitPayload {
  prompt: string
  files: File[]
  workspaceId: string
  mentions: string[]
  confirm?: () => void
  release?: () => void
}

/** 内嵌 ConversationView 向空间页底栏登记的执行与续写能力。 */
export interface TeamComposerBridge {
  sessionId: string
  /** 当前路由目标是 Run 详情（续写轨），否则为会话线程轨。 */
  viewingRun: boolean
  running: boolean
  stopping: boolean
  /** 内嵌会话未滚到底时，由空间页底栏展示「回到最新消息」。 */
  showJumpToLatest: boolean
  scrollToLatest: (() => void) | null
  stop: (() => void) | null
  submitSession: ((payload: TeamComposerSubmitPayload) => void) | null
  submitFollowUp: ((payload: TeamComposerSubmitPayload) => void) | null
}

export function createEmptyTeamComposerBridge(): TeamComposerBridge {
  return {
    sessionId: '',
    viewingRun: false,
    running: false,
    stopping: false,
    showJumpToLatest: false,
    scrollToLatest: null,
    stop: null,
    submitSession: null,
    submitFollowUp: null,
  }
}

export const teamComposerBridgeKey: InjectionKey<Ref<TeamComposerBridge>> = Symbol('teamComposerBridge')
