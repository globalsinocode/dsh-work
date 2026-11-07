<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Document } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import type { SkillDraft } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * Skill 草稿卡片（Skill 创建专家方案 4.3，原型已确认）。只显示平台能证明的事：文件清单与包校验结论；
 * 专家在执行容器中的试跑与保存的包没有绑定，卡片不声称“试跑通过”。提交审核只能由员工在卡片上发起（SC2）。
 */
const props = defineProps<{ drafts: SkillDraft[] }>()

/** 提交或撤回后的最新状态，按提交记录覆盖；下次加载会话详情时以服务端为准。 */
const overrides = reactive(new Map<string, Pick<SkillDraft, 'status' | 'submittedAt'>>())
const busy = ref('')
const previews = reactive(new Map<string, { open: boolean; loading: boolean; content: string; error: string }>())

const cards = computed(() => props.drafts.map(draft => ({ ...draft, ...(overrides.get(draft.submissionId) ?? {}) })))

const statusLabels: Record<SkillDraft['status'], string> = {
  draft: '草稿', pending: '待审核', approved: '已发布', rejected: '未通过',
}

function formatSize(size: number) {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`
}

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function checkSummary(draft: SkillDraft) {
  if (draft.compatibility.status === 'incompatible') return '包校验：未通过'
  const warnings = draft.compatibility.issues.length
  return warnings ? `包校验：通过，有 ${warnings} 条提醒` : '包校验：通过'
}

async function submit(draft: SkillDraft) {
  busy.value = draft.submissionId
  try {
    const updated = await workbenchApi.submitSkillDraft(draft.submissionId, draft.versionId)
    overrides.set(draft.submissionId, { status: updated.status, submittedAt: updated.submittedAt })
  } catch (error) {
    notifyActionFailure('提交审核', `Skill 草稿“${draft.name}”`, error)
  } finally {
    busy.value = ''
  }
}

async function withdraw(draft: SkillDraft) {
  busy.value = draft.submissionId
  try {
    const updated = await workbenchApi.withdrawSkillDraft(draft.submissionId)
    overrides.set(draft.submissionId, { status: updated.status, submittedAt: updated.submittedAt })
  } catch (error) {
    notifyActionFailure('撤回提交', `Skill 草稿“${draft.name}”`, error)
  } finally {
    busy.value = ''
  }
}

async function togglePreview(draft: SkillDraft) {
  const current = previews.get(draft.versionId)
  if (current?.open) { current.open = false; return }
  if (current?.content) { current.open = true; return }
  previews.set(draft.versionId, { open: true, loading: true, content: '', error: '' })
  // 取回 Map 中的响应式副本再修改，界面才会更新。
  const state = previews.get(draft.versionId)!
  try {
    state.content = (await workbenchApi.getSkillDraftFile(draft.submissionId, draft.versionId)).content
  } catch {
    state.error = 'SKILL.md 暂时无法读取，请稍后重试。'
  } finally {
    state.loading = false
  }
}
</script>

<template>
  <section v-if="cards.length" class="skill-drafts" data-testid="skill-drafts">
    <template v-for="draft in cards" :key="draft.versionId">
      <p v-if="!draft.latest" class="skill-draft__superseded" data-testid="skill-draft-superseded">
        {{ draft.name }} · 草稿 v{{ draft.versionNumber }} · 已由新版本替代
      </p>
      <article v-else class="skill-draft" :aria-label="`Skill 草稿：${draft.name}`" data-testid="skill-draft-card">
        <header class="skill-draft__head">
          <div class="skill-draft__chips">
            <el-icon aria-hidden="true"><Document /></el-icon>
            <span>Skill 草稿</span>
            <span class="skill-draft__chip">草稿 v{{ draft.versionNumber }}</span>
            <span class="skill-draft__chip" :class="`skill-draft__chip--${draft.status}`">{{ statusLabels[draft.status] }}</span>
          </div>
          <strong class="skill-draft__name">{{ draft.name }}</strong>
          <p class="skill-draft__description">{{ draft.description }}</p>
        </header>

        <div class="skill-draft__body">
          <span class="skill-draft__label">文件</span>
          <ul class="skill-draft__files">
            <li v-for="file in draft.files" :key="file.path">
              <code>{{ file.path }}</code>
              <span v-if="file.script" class="skill-draft__tag skill-draft__tag--script">脚本</span>
              <span class="skill-draft__size">{{ formatSize(file.size) }}</span>
            </li>
          </ul>
          <p class="skill-draft__check" :class="{ 'skill-draft__check--failed': draft.compatibility.status === 'incompatible' }">{{ checkSummary(draft) }}</p>
          <ul v-if="draft.compatibility.issues.length" class="skill-draft__issues">
            <li v-for="issue in draft.compatibility.issues" :key="issue.code + issue.message">{{ issue.message }}</li>
          </ul>
          <el-button text type="primary" class="skill-draft__preview-toggle" :aria-expanded="previews.get(draft.versionId)?.open ? 'true' : 'false'" @click="togglePreview(draft)">
            {{ previews.get(draft.versionId)?.open ? '收起 SKILL.md' : '预览 SKILL.md' }}
          </el-button>
          <template v-if="previews.get(draft.versionId)?.open">
            <p v-if="previews.get(draft.versionId)?.loading" class="skill-draft__muted">正在读取…</p>
            <p v-else-if="previews.get(draft.versionId)?.error" class="skill-draft__muted" role="alert">{{ previews.get(draft.versionId)?.error }}</p>
            <pre v-else class="skill-draft__preview" data-testid="skill-draft-preview">{{ previews.get(draft.versionId)?.content }}</pre>
          </template>
        </div>

        <footer class="skill-draft__foot">
          <template v-if="draft.status === 'draft'">
            <p class="skill-draft__muted">提交后由平台管理员审核；通过后按管理员设定的范围出现在 Skill 广场。同时最多 5 条待审核提交。</p>
            <el-button
              type="primary"
              :disabled="draft.compatibility.status === 'incompatible'"
              :loading="busy === draft.submissionId"
              data-action="submit-skill-draft"
              @click="submit(draft)"
            >提交审核</el-button>
          </template>
          <template v-else-if="draft.status === 'pending'">
            <p class="skill-draft__status skill-draft__status--pending" role="status">
              已提交审核{{ draft.submittedAt ? `（${formatTime(draft.submittedAt)}）` : '' }}。平台管理员审核后会通知你。
            </p>
            <el-button :loading="busy === draft.submissionId" data-action="withdraw-skill-draft" @click="withdraw(draft)">撤回提交</el-button>
          </template>
          <p v-else-if="draft.status === 'approved'" class="skill-draft__status skill-draft__status--approved" role="status">
            已通过审核并发布到 Skill 广场。
          </p>
          <div v-else class="skill-draft__status skill-draft__status--rejected" role="status">
            <strong>审核未通过</strong>
            <span v-if="draft.reviewNote">{{ draft.reviewNote }}</span>
            <span class="skill-draft__muted">可以告诉 Skill 创建专家按原因修改，保存的新版本可以再次提交。</span>
          </div>
        </footer>
      </article>
    </template>
  </section>
</template>

<style scoped>
.skill-drafts { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
.skill-draft { display: flex; flex-direction: column; max-width: 640px; border: 1px solid var(--dsh-color-border); border-radius: var(--dsh-radius-md); background: var(--dsh-color-panel); }
.skill-draft__head { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--dsh-color-border); }
.skill-draft__chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); }
.skill-draft__chips .el-icon { color: var(--dsh-color-brand); }
.skill-draft__chip { padding: 2px 8px; border-radius: 999px; background: var(--dsh-color-canvas); color: var(--dsh-color-text); }
.skill-draft__chip--pending { background: var(--dsh-color-brand-soft); color: var(--dsh-color-brand-dark); }
.skill-draft__chip--approved { background: var(--dsh-color-success-soft); color: var(--dsh-color-success); }
.skill-draft__chip--rejected { background: var(--dsh-color-danger-soft); color: var(--dsh-color-danger); }
.skill-draft__name { color: var(--dsh-color-ink); font-size: var(--dsh-font-size-body); overflow-wrap: anywhere; }
.skill-draft__description { margin: 0; color: var(--dsh-color-text); font-size: var(--dsh-font-size-caption); line-height: 1.6; }
.skill-draft__body { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--dsh-color-border); }
.skill-draft__label { color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); }
.skill-draft__files { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: var(--dsh-font-size-caption); }
.skill-draft__files li { display: flex; align-items: center; gap: 8px; min-width: 0; }
.skill-draft__files code { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.skill-draft__tag { padding: 1px 6px; border-radius: 4px; font-size: var(--dsh-font-size-badge); }
.skill-draft__tag--script { background: var(--dsh-color-warning-soft); color: var(--dsh-color-warning); }
.skill-draft__size { margin-left: auto; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); white-space: nowrap; }
.skill-draft__check { margin: 0; color: var(--dsh-color-success); font-size: var(--dsh-font-size-badge); }
.skill-draft__check--failed { color: var(--dsh-color-danger); }
.skill-draft__issues { margin: 0; padding-left: 18px; color: var(--dsh-color-text); font-size: var(--dsh-font-size-badge); line-height: 1.6; }
.skill-draft__preview-toggle { align-self: flex-start; }
.skill-draft__preview { max-height: 240px; margin: 0; padding: 10px 12px; overflow: auto; border: 1px solid var(--dsh-color-border); border-radius: var(--dsh-radius-sm); background: var(--dsh-color-canvas); color: var(--dsh-color-text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--dsh-font-size-badge); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.skill-draft__foot { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 12px 16px; }
.skill-draft__foot .el-button { min-height: 40px; }
.skill-draft__muted { margin: 0; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); line-height: 1.6; }
.skill-draft__status { margin: 0; padding: 8px 12px; border-radius: var(--dsh-radius-sm); font-size: var(--dsh-font-size-caption); line-height: 1.6; }
.skill-draft__status--pending { background: var(--dsh-color-brand-soft); color: var(--dsh-color-brand-dark); }
.skill-draft__status--approved { background: var(--dsh-color-success-soft); color: var(--dsh-color-success); }
.skill-draft__status--rejected { display: flex; flex-direction: column; gap: 4px; background: var(--dsh-color-danger-soft); color: var(--dsh-color-danger); }
.skill-draft__status--rejected span:not(.skill-draft__muted) { color: var(--dsh-color-text); }
.skill-draft__superseded { max-width: 640px; margin: 0; padding: 10px 12px; border: 1px dashed var(--dsh-color-border); border-radius: var(--dsh-radius-sm); color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); }
</style>
