<script setup lang="ts">
import { Check } from '@element-plus/icons-vue'

import { useUiModeStore } from '@/stores/ui-mode'
import type { UiMode } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * 左上角 logo 的模式菜单（项目空间方案 D18）：两种模式的壳层共用。切换只换界面，
 * 不改数据、不中断进行中的执行；壳层与地址随模式变化由 App 统一处理。
 */
withDefaults(defineProps<{ placement?: 'bottom-start' | 'right-start' }>(), { placement: 'bottom-start' })

const uiMode = useUiModeStore()

const modes: Array<{ value: UiMode; label: string; description: string }> = [
  { value: 'work', label: '工作模式', description: '任务表格 + 任务详情' },
  { value: 'collab', label: '协作模式', description: '对话、群组为中心' },
]

async function onCommand(command: string | number | object) {
  const next = String(command) as UiMode
  const label = modes.find(item => item.value === next)?.label ?? next
  try {
    await uiMode.setMode(next)
  } catch (cause) {
    notifyActionFailure('切换模式', label, cause, '当前界面保持不变，请稍后重试。')
  }
}
</script>

<template>
  <el-dropdown trigger="click" :placement="placement" :disabled="uiMode.switching" @command="onCommand">
    <button class="mode-switch" type="button" aria-label="切换模式">
      <slot />
    </button>
    <template #dropdown>
      <el-dropdown-menu class="mode-switch-menu" aria-label="选择模式">
        <el-dropdown-item v-for="item in modes" :key="item.value" :command="item.value">
          <span class="mode-switch-menu__copy">
            <strong>{{ item.label }}</strong>
            <small>{{ item.description }}</small>
          </span>
          <span v-if="uiMode.mode === item.value" class="mode-switch-menu__current">
            <el-icon aria-hidden="true"><Check /></el-icon>
            <span class="mode-switch-menu__sr">当前模式</span>
          </span>
        </el-dropdown-item>
        <li class="mode-switch-menu__note" role="presentation">按账号记住选择；两种模式数据相同</li>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.mode-switch {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border: 0;
  border-radius: var(--dsh-radius-md);
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.mode-switch:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

:global(.mode-switch-menu) { min-width: 232px; padding: 6px; }
:global(.mode-switch-menu .el-dropdown-menu__item) { gap: 10px; padding: 9px 12px; border-radius: var(--dsh-radius-sm); }
:global(.mode-switch-menu__copy) { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; line-height: 1.35; }
:global(.mode-switch-menu__copy strong) { color: var(--dsh-color-ink); font-weight: 620; }
:global(.mode-switch-menu__copy small) { color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); }
:global(.mode-switch-menu__current) { display: inline-flex; color: var(--el-color-primary); }
:global(.mode-switch-menu__sr) {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
:global(.mode-switch-menu__note) { padding: 8px 12px 4px; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); list-style: none; }
</style>
