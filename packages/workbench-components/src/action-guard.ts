/**
 * 员工端主交互防连点（发送、重试、下载等）统一窗口。
 * TaskComposer 通过 `createActionGate` 在 release 后立刻可再试；
 * 下载等场景用 `runGuardedAction` 在完成后仍保留冷却窗口。
 */
export const ACTION_GUARD_DEBOUNCE_MS = 600

interface KeyedGuardState {
  inFlight?: Promise<void>
  lastAt: number
}

const keyedState = new Map<string, KeyedGuardState>()

function keyedStore(key: string): KeyedGuardState {
  let state = keyedState.get(key)
  if (!state) {
    state = { lastAt: 0 }
    keyedState.set(key, state)
  }
  return state
}

export interface RunGuardedActionOptions {
  debounceMs?: number
}

/**
 * 按 key 合并并发执行，并在距上次触发后的防抖窗口内忽略重复调用（含完成后冷却）。
 */
export function runGuardedAction(
  key: string,
  action: () => Promise<void>,
  options: RunGuardedActionOptions = {},
): Promise<void> {
  const debounceMs = options.debounceMs ?? ACTION_GUARD_DEBOUNCE_MS
  const state = keyedStore(key)

  if (state.inFlight) return state.inFlight

  const now = Date.now()
  if (state.lastAt > 0 && now - state.lastAt < debounceMs) return Promise.resolve()

  state.lastAt = now
  const job = action().finally(() => {
    state.inFlight = undefined
  })
  state.inFlight = job
  return job
}

/** 清除某 key 的防抖记账（测试或显式重置时使用）。 */
export function resetGuardedAction(key: string) {
  const state = keyedState.get(key)
  if (state) state.lastAt = 0
}

export interface ActionGate {
  /** 短窗口内或已占用时返回 false。 */
  tryBegin(): boolean
  /** 异步结束或父级拦截后调用，允许立刻再次触发。 */
  release(): void
}

/** 发送消息等：与 TaskComposer 原 `lastSubmitAt` + `release` 同口径。 */
export function createActionGate(debounceMs = ACTION_GUARD_DEBOUNCE_MS): ActionGate {
  let lastAt = 0
  return {
    tryBegin() {
      const now = Date.now()
      if (lastAt > 0 && now - lastAt < debounceMs) return false
      lastAt = now
      return true
    },
    release() {
      lastAt = 0
    },
  }
}
