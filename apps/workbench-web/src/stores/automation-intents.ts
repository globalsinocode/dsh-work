import { defineStore } from 'pinia'

import { createIntentRegistry, isUncertainRequestFailure } from '../utils/idempotent-intent'

export type AutomationIntentOperation = 'run-now' | 'trial-run'

const registry = createIntentRegistry()
const activeSlots = new Set<string>()

function slotKey(automationId: string, operation: AutomationIntentOperation): string {
  return `${automationId}:${operation}`
}

export const useAutomationIntentStore = defineStore('automation-intents', () => {
  function begin(
    automationId: string,
    operation: AutomationIntentOperation,
    options?: { fresh?: boolean },
  ): string {
    const slot = slotKey(automationId, operation)
    if (options?.fresh) registry.clear(slot)
    activeSlots.add(slot)
    return registry.begin(slot, operation).key
  }

  function markUncertain(automationId: string, operation: AutomationIntentOperation, key: string) {
    registry.markUncertain(slotKey(automationId, operation), key)
  }

  function complete(automationId: string, operation: AutomationIntentOperation, key: string) {
    const slot = slotKey(automationId, operation)
    registry.complete(slot, key)
    activeSlots.delete(slot)
  }

  function settleFailure(automationId: string, operation: AutomationIntentOperation, key: string, error: unknown) {
    const slot = slotKey(automationId, operation)
    if (isUncertainRequestFailure(error)) {
      registry.markUncertain(slot, key)
      return
    }
    if (typeof error === 'object' && error !== null) {
      const status = (error as { status?: unknown }).status
      if (typeof status === 'number' && status >= 400 && status < 500) {
        registry.clear(slot)
        return
      }
    }
    registry.clear(slot)
  }

  function reset() {
    for (const slot of activeSlots) registry.clear(slot)
    activeSlots.clear()
  }

  return { begin, markUncertain, complete, settleFailure, reset }
})
