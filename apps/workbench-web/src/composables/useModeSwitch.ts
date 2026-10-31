import { computed } from 'vue'

import { useUiModeStore } from '@/stores/ui-mode'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * 底部用户栏的模式切换入口（工作模式侧栏用户栏、协作模式头像菜单共用）：
 * 文案按当前模式显示目标模式（工作模式 → 「切换至协作模式」，反之亦然），
 * 点击即切到另一模式；保存失败时保持原模式并提示。
 * 左上角 logo 的完整模式菜单见 ModeSwitchMenu。
 */
export function useModeSwitch() {
  const uiMode = useUiModeStore()

  const switchLabel = computed(() => (uiMode.mode === 'work' ? '切换至协作模式' : '切换至工作模式'))

  async function switchMode() {
    const next = uiMode.mode === 'work' ? 'collab' : 'work'
    try {
      await uiMode.setMode(next)
    } catch (cause) {
      notifyActionFailure('切换模式', next === 'collab' ? '协作模式' : '工作模式', cause, '当前界面保持不变，请稍后重试。')
    }
  }

  return { switchLabel, switchMode }
}
