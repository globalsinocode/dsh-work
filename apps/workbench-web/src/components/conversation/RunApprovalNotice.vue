<script setup lang="ts">
import { Lock } from '@element-plus/icons-vue'
import { StatusTag } from '@dsh-work/ui-core'

import type { TaskRun } from '@/types/domain'
import '@/styles/conversation-thread.css'

/** 等待本轮工具权限确认的说明。会话页的 RunMessageList 与任务对话共用（D37）。 */
defineProps<{ task: TaskRun }>()
</script>

<template>
  <section class="conversation-notice approval-notice" data-testid="run-approval-notice">
    <span class="conversation-notice__icon"><el-icon><Lock /></el-icon></span>
    <div>
      <strong>等待本轮工具权限确认</strong>
      <p>{{ task.approval?.reason ?? '服务端已暂停当前执行并保留审批所需的动作边界。' }}</p>
      <dl>
        <div><dt>对象</dt><dd class="mono">{{ task.approval?.object ?? '受控工具' }}</dd></div>
        <div><dt>范围</dt><dd>{{ task.approval?.dataScope ?? '当前用户授权范围' }}</dd></div>
      </dl>
      <p>{{ task.approval?.nextStep ?? '审批完成后会从新的 Attempt 继续执行，无需重复提交。' }}</p>
    </div>
    <StatusTag status="awaiting_approval" label="等待确认" />
  </section>
</template>
