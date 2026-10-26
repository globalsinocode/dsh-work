<script setup lang="ts">
import { computed } from 'vue'

import { AGENT_DRAFT_BOUNDS, useAgentDraftEditor } from '@/composables/use-agent-draft'

const editor = useAgentDraftEditor()
const form = editor.form
const readonly = computed(() => !editor.canEdit.value)
const promptBounds = AGENT_DRAFT_BOUNDS.examplePrompts

function addPrompt() {
  if (form.examplePrompts.length < promptBounds.max) form.examplePrompts.push('')
}

function removePrompt(index: number) {
  form.examplePrompts.splice(index, 1)
  if (!form.examplePrompts.length) form.examplePrompts.push('')
}
</script>

<template>
  <section class="detail-section" aria-label="职责与人格">
    <header class="detail-section__head">
      <div><h3>职责与人格</h3><p>员工看到的名称与说明、Agent 的人格与工作规程。修改后自动保存到草稿，验证并发布后才对员工生效。</p></div>
    </header>
    <el-form label-position="top" class="profile-form" @submit.prevent>
      <div class="profile-grid">
        <el-form-item label="Agent 名称" :error="editor.errors.name" required>
          <el-input v-model="form.name" :maxlength="AGENT_DRAFT_BOUNDS.name.max" show-word-limit :readonly="readonly" placeholder="例如：质量异常分析助手" />
        </el-form-item>
        <el-form-item label="欢迎语（选填）" :error="editor.errors.welcomeMessage">
          <el-input v-model="form.welcomeMessage" :maxlength="AGENT_DRAFT_BOUNDS.welcomeMessage.max" show-word-limit :readonly="readonly" placeholder="留空时按名称和说明自动生成" />
        </el-form-item>
      </div>
      <el-form-item label="Agent 说明" :error="editor.errors.description" required>
        <el-input v-model="form.description" type="textarea" :rows="3" :maxlength="AGENT_DRAFT_BOUNDS.description.max" show-word-limit :readonly="readonly" placeholder="说明这个 Agent 面向谁、能够解决什么问题" />
      </el-form-item>
      <el-form-item label="SOUL.md（人格与工作原则）" :error="editor.errors.systemPrompt" required>
        <el-input v-model="form.systemPrompt" type="textarea" :rows="8" :maxlength="AGENT_DRAFT_BOUNDS.instructions.max" show-word-limit :readonly="readonly" placeholder="定义 Agent 的稳定职责、工作原则、沟通风格、禁止事项和转人工条件" />
        <p class="field-help">随版本固定；不要填写凭据或密钥。</p>
      </el-form-item>
      <el-form-item label="AGENTS.md（工作规程，选填）" :error="editor.errors.workInstructions">
        <el-input v-model="form.workInstructions" type="textarea" :rows="6" :maxlength="AGENT_DRAFT_BOUNDS.instructions.max" show-word-limit :readonly="readonly" placeholder="例如：如何核对输入、使用状态与经验、验证结果，以及何时交接给人工" />
        <p class="field-help">留空时不生成文件；填写后作为版本指令固定，不会读取服务器工作目录的同名文件。</p>
      </el-form-item>
      <el-form-item label="员工端示例问题" :error="editor.errors.examplePrompts" required>
        <div class="prompt-list">
          <div v-for="(_, index) in form.examplePrompts" :key="index" class="prompt-list__row">
            <el-input v-model="form.examplePrompts[index]" :maxlength="promptBounds.itemMax" :readonly="readonly" :aria-label="`员工端示例问题 ${index + 1}`" placeholder="例如：请介绍你能提供哪些帮助" />
            <el-button v-if="!readonly && form.examplePrompts.length > 1" text type="danger" @click="removePrompt(index)">删除</el-button>
          </div>
          <el-button v-if="!readonly" size="small" :disabled="form.examplePrompts.length >= promptBounds.max" @click="addPrompt">添加示例问题</el-button>
        </div>
        <p class="field-help">员工端展示，也会作为验证案例运行（最多 {{ promptBounds.max }} 个）。</p>
      </el-form-item>
    </el-form>
  </section>
</template>

<style scoped>
.profile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.field-help { width: 100%; margin: 5px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.5; }
.prompt-list { display: grid; width: 100%; gap: 8px; }
.prompt-list__row { display: flex; align-items: center; gap: 8px; }
.prompt-list .el-button { justify-self: start; }
:deep(.el-form-item__label) { color: var(--color-text-heading); font-weight: var(--font-weight-title); }
@media (max-width: 760px) { .profile-grid { grid-template-columns: 1fr; } }
</style>
