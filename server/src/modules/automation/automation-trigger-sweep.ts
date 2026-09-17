import type { ReservedSql } from 'postgres'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { slotsBetween } from './automation-calendar.ts'
import type { PostgresAutomationRepository } from './postgres-automation-repository.ts'
import type { AutomationService } from './automation-service.ts'
import type { AutomationModuleConfig, AutomationRecord } from './automation-types.ts'

const OWNER_LOCK_NAME = 'dsh-work-automation-trigger-sweep'

/**
 * AG-03 触发扫描（轻量版语义）：
 * - 单一调度所有者：pg advisory lock 持锁进程才有资格扫描；第二个
 *   实例/进程 try-lock 失败即不启动（同机多副本天然防双发）。
 * - 每轮取「enabled 且 next_slot_utc 已到期」的任务；槽位迟到容差内正常
 *   受理，超容差的停机缺口合并为一条 missed 记录，不补跑。
 * - 启动先做「受理中断」收敛（Run 无 Attempt），再恢复未来日历。
 */
export class AutomationTriggerSweep {
  private readonly database: DatabaseClient
  private readonly automations: PostgresAutomationRepository
  private readonly service: AutomationService
  private readonly config: AutomationModuleConfig
  private timer?: NodeJS.Timeout
  private lockConnection?: ReservedSql
  private processing = false
  private closed = false

  constructor(
    database: DatabaseClient,
    automations: PostgresAutomationRepository,
    service: AutomationService,
    config: AutomationModuleConfig,
  ) {
    this.database = database
    this.automations = automations
    this.service = service
    this.config = config
  }

  /** 返回 false 表示已有其它进程持有调度所有权，本进程不启动扫描。 */
  async start(): Promise<boolean> {
    const connection = await this.database.reserve()
    const [held] = await connection<{ ok: boolean }[]>`
      select pg_try_advisory_lock(hashtext(${OWNER_LOCK_NAME})) as ok
    `
    if (!held?.ok) {
      await connection.release()
      console.warn('automation trigger sweep not started: another process holds the owner lock')
      return false
    }
    this.lockConnection = connection
    try {
      const recovered = await this.service.recoverInterruptedPreparations()
      if (recovered > 0) {
        console.warn(`automation startup recovery: ${recovered} interrupted preparation(s) marked`)
      }
      await this.tick()
    } catch (error) {
      // 启动失败必须连同会话锁一起释放：否则锁挂在游离/归还的池化连接上，
      // 其它实例永远无法取得调度所有权。
      await this.close()
      throw error
    }
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        console.error('automation trigger sweep tick failed', error)
      })
    }, this.config.sweepIntervalMs)
    this.timer.unref()
    return true
  }

  /**
   * 调度锁活性检查：锁绑定在 ReservedSql 会话上，连接静默断开时 PG
   * 已释放锁而本进程无从感知——每轮 tick 在锁连接上探活，断开即停止
   * 扫描，避免与新的持锁实例形成双调度者。
   * 注意不能用 pg_try_advisory_lock 做探活：会话级 advisory lock 对持有者
   * 可重入且计数累加，每轮 +1 会让 close() 的单次 unlock 解不干净，锁随
   * 连接归还连接池而泄漏（其它实例永远拿不到所有权）。select 1 语义等价：
   * 会话活着锁必仍持有，会话断开锁已被 PG 释放。
   */
  private async verifyOwnerLock(): Promise<boolean> {
    if (!this.lockConnection) return false
    try {
      await this.lockConnection`select 1`
      return true
    } catch {
      return false
    }
  }

  async tick(): Promise<void> {
    if (this.processing || this.closed) return
    // 仅在 start() 已持锁后校验活性；测试或外部驱动直接调 tick() 时无锁连接可查。
    if (this.lockConnection && !await this.verifyOwnerLock()) {
      console.error('automation trigger sweep owner lock lost; stopping sweep')
      this.closed = true
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      return
    }
    this.processing = true
    try {
      const now = new Date()
      for (const task of await this.automations.listDue(now)) {
        await this.processTask(task, now).catch((error: unknown) => {
          console.error(`automation task ${task.id} sweep failed`, error)
        })
      }
    } finally {
      this.processing = false
    }
  }

  private async processTask(task: AutomationRecord, now: Date): Promise<void> {
    const cursor = task.nextSlotUtc
    if (!cursor) return
    // next_slot_utc 本身是下一个未处理槽位，枚举区间要包含它。
    const from = new Date(new Date(cursor).getTime() - 1)
    const slots = slotsBetween(task.schedule, from, now, this.config.maxSlotsPerTaskPerTick)
    if (slots.length === 0) return

    const missed = slots.filter(slot => now.getTime() - slot.getTime() > this.config.maxSlotLatenessMs)
    const fresh = slots.filter(slot => now.getTime() - slot.getTime() <= this.config.maxSlotLatenessMs)

    let expectedCursor: string | null = cursor
    if (missed.length > 0) {
      const lastMissed = missed.at(-1)!
      const after = this.nextSlotAfter(task, lastMissed)
      await this.service.recordMissedRange(
        task.id, missed[0]!, lastMissed, expectedCursor, after?.toISOString() ?? null,
      )
      // 游标推进由事务内条件更新保证；重读任务取真实游标——若已被另一
      // 处理器移动，后续槽位的期望游标不匹配会安全落空。
      const refreshed = await this.automations.getById(task.id)
      expectedCursor = refreshed?.nextSlotUtc ?? null
    }
    for (const slot of fresh) {
      const after = this.nextSlotAfter(task, slot)
      const outcome = await this.service.processScheduledSlot(
        task.id, slot, expectedCursor ?? slot.toISOString(), after?.toISOString() ?? null,
      )
      expectedCursor = after?.toISOString() ?? null
      if (outcome === null) break
    }
  }

  private nextSlotAfter(task: AutomationRecord, slot: Date): Date | null {
    const [next] = slotsBetween(task.schedule, slot, new Date('2100-01-01T00:00:00Z'), 1)
    return next ?? null
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.lockConnection) {
      try {
        // 一次释放本会话累计持有的全部 advisory lock，再归还连接——防止
        // 任何重入计数残留把锁泄漏给池化会话。
        await this.lockConnection`select pg_advisory_unlock_all()`
      } catch { /* 连接已断开时锁随会话消亡，无需解锁 */ }
      await this.lockConnection.release()
      this.lockConnection = undefined
    }
  }
}
