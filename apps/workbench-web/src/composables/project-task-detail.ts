import type { InjectionKey, Ref } from 'vue'

import type { ProjectTask, ProjectTaskAction, ProjectTaskEvent } from '@/types/domain'

/**
 * 项目空间 S3：任务详情与嵌在其中的任务对话之间的桥。
 *
 * 任务详情（ProjectTaskPanel）负责任务本身：读取、写动作与完成弹窗；任务对话
 * （ConversationView 的任务线程子路由）只负责对话，经此读取当前任务与任务事件，
 * 并请求“开始执行”“标记完成”和刷新，不重复实现任务写入。
 */
export interface ProjectTaskDetailBridge {
  /** 当前任务；加载中或读取失败时为 null。 */
  task: Readonly<Ref<ProjectTask | null>>
  /** 任务事件（员工任务的状态推进、完成与同类改派），按发生时间正序。 */
  events: Readonly<Ref<ProjectTaskEvent[]>>
  /** 写动作同时要求服务端允许与当前仍可写。 */
  can: (action: ProjectTaskAction) => boolean
  /** 启动尚未执行的 Agent 任务，可附补充要求；成功返回 true。 */
  start: (prompt?: string) => Promise<boolean>
  /** 打开员工任务的“标记完成”弹窗。 */
  openComplete: () => void
  /** 对话中发生了可能改变任务状态的动作（发言、执行）后刷新任务与事件。 */
  refresh: () => Promise<void>
}

export const projectTaskDetailKey: InjectionKey<ProjectTaskDetailBridge> = Symbol('projectTaskDetail')
