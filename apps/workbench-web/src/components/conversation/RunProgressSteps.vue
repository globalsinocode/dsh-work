<script setup lang="ts">
import { computed } from 'vue'

import { elapsedMs, formatElapsed, type ProgressRow } from '@/utils/run-progress-steps'

/**
 * EX-PROGRESS-01：执行步骤列表（工具调用与其间的思考）。执行中的卡片与结束后的收起摘要共用；
 * 进行中行的计时由父组件传入的 `now` 驱动，本组件不自带时钟。
 */
const props = withDefaults(defineProps<{
  rows: ProgressRow[]
  now?: number
  clockOffsetMs?: number
}>(), { now: 0, clockOffsetMs: 0 })

const stateText: Record<ProgressRow['state'], string> = { active: '进行中', done: '已完成', failed: '失败', unknown: '未收到结果' }

const items = computed(() => props.rows.map(row => ({
  ...row,
  time: formatElapsed(row.state === 'active'
    ? elapsedMs(row.startMs, props.now, props.clockOffsetMs)
    : row.startMs !== undefined && row.endMs !== undefined ? row.endMs - row.startMs : undefined),
})))
</script>

<template>
  <ol class="run-progress-steps" aria-label="执行步骤">
    <li
      v-for="item in items"
      :key="item.key"
      class="run-progress-step"
      :class="`run-progress-step--${item.state}`"
      data-testid="run-progress-step"
    >
      <span class="run-progress-step__mark" aria-hidden="true">
        <span v-if="item.state === 'active'" class="run-progress-step__spinner" />
        <template v-else-if="item.state === 'failed'">✕</template>
        <template v-else-if="item.state === 'unknown'">?</template>
        <template v-else>✓</template>
      </span>
      <span class="run-progress-step__label">{{ item.label }}<small
        v-if="item.state === 'failed' || item.state === 'unknown'"
      >{{ stateText[item.state] }}</small><span v-else class="run-progress-sr">，{{ stateText[item.state] }}</span></span>
      <span v-if="item.time" class="run-progress-step__time">{{ item.time }}</span>
    </li>
  </ol>
</template>
