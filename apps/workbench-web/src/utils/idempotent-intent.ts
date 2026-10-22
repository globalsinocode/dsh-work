import { isTransientRequestError } from './request-error'

export interface IntentHandle {
  key: string
  fingerprint: string
}

interface IntentSlotState {
  key: string
  fingerprint: string
  state: 'pending' | 'uncertain'
}

export interface IntentRegistry {
  begin(slot: string, fingerprint: string): IntentHandle
  markUncertain(slot: string, key: string): void
  complete(slot: string, key: string): void
  clear(slot: string): void
}

export function createIntentRegistry(generate = () => crypto.randomUUID()): IntentRegistry {
  const slots = new Map<string, IntentSlotState>()

  return {
    begin(slot, fingerprint) {
      const existing = slots.get(slot)
      if (existing && existing.fingerprint === fingerprint && (existing.state === 'pending' || existing.state === 'uncertain')) {
        return { key: existing.key, fingerprint: existing.fingerprint }
      }
      if (existing && existing.fingerprint !== fingerprint) {
        throw new Error('意图内容已变化')
      }
      const key = generate()
      slots.set(slot, { key, fingerprint, state: 'pending' })
      return { key, fingerprint }
    },
    markUncertain(slot, key) {
      const existing = slots.get(slot)
      if (!existing || existing.key !== key) return
      existing.state = 'uncertain'
    },
    complete(slot, key) {
      const existing = slots.get(slot)
      if (existing?.key === key) slots.delete(slot)
    },
    clear(slot) {
      slots.delete(slot)
    },
  }
}

export function isUncertainRequestFailure(error: unknown): boolean {
  return isTransientRequestError(error)
}
