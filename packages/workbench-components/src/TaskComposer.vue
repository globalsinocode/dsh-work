<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  ArrowDown,
  ArrowUp,
  Close,
  Files,
  FolderOpened,
  Loading,
  Lock,
  Microphone,
  Paperclip,
  Plus,
  Search,
  VideoPause,
} from '@element-plus/icons-vue'

const props = withDefaults(
  defineProps<{
    initialPrompt?: string
    initialWorkspaceId?: string
    initialWorkspaceName?: string
    workspaces?: Array<{ id: string; name: string; type: 'personal' | 'team' }>
    workspaceLocked?: boolean
    compact?: boolean
    submitting?: boolean
    running?: boolean
    stopping?: boolean
    selectedSkillName?: string
    /**
     * 团队空间尚未选中可用 Agent 成员时阻止提交（TW-02）：后端只接受带
     * workspaceAgentMemberId 的团队会话，前端先行拦住无意义的失败请求。
     */
    blockedReason?: string
    /**
     * TW-10 共享讨论：团队会话里可 @ 的 Agent 成员（workspace_agent_member id
     * + 展示名）。非空时输入 `@` 弹出补全；提交时在最终文本里把 `@名称`
     * 解析回成员 id 放进 mentions。
     */
    mentionOptions?: Array<{ id: string; name: string }>
    /**
     * TW-10：团队会话中「带附件但未 @Agent」没有对应语义（讨论消息不支持附件）。
     * 开启后提交时在组件内拦截并保留输入与文件，而不是交给调用方丢弃。
     */
    filesRequireMention?: boolean
  }>(),
  {
    initialPrompt: '',
    initialWorkspaceId: '',
    initialWorkspaceName: '',
    workspaces: () => [],
    workspaceLocked: false,
    compact: false,
    submitting: false,
    running: false,
    stopping: false,
    selectedSkillName: '',
    blockedReason: '',
    mentionOptions: () => [],
    filesRequireMention: false,
  },
)

const emit = defineEmits<{
  submit: [payload: {
    prompt: string
    files: File[]
    workspaceId: string
    mentions: string[]
    /**
     * 父级确认提交（上传/建 Run/发消息）成功后调用以清空草稿；异步失败时
     * 不要调用——输入、附件与提及选择全部保留，用户可直接重试。
     */
    confirm: () => void
  }]
  stop: []
  'clear-skill': []
}>()

const prompt = ref(props.initialPrompt)
const workspaceId = ref(props.initialWorkspaceId)
const files = ref<File[]>([])
const fileInput = ref<HTMLInputElement>()
const inputRef = ref<HTMLTextAreaElement>()
const isDragging = ref(false)

// ---- TW-10 @Agent 提及补全 ----
// 光标前最近的 `@非空白*` 片段即提及查询；选中后把该片段替换为 `@名称 `，
// 提交时再把文本中的 `@名称` 解析回成员 id（删掉文本即放弃提及）。
// 光标移动不触发响应式依赖，统一在 input/keyup/click 后显式重算。
const mentionQuery = ref<string | null>(null)
const mentionStart = ref(-1)
const mentionIndex = ref(0)
/**
 * 下拉选中的提及记录（id + 名称 + 插入位置）。提交时先按位置精确回放，
 * 保证重名 Agent 成员消歧到用户实际点击的那一项；手工输入或文本被编辑后
 * 位置漂移的提及，再由名称匹配按文本出现顺序兜底。
 */
const appliedMentions = ref<Array<{ id: string; name: string; start: number }>>([])

const filteredMentions = computed(() => {
  const query = mentionQuery.value
  if (query === null) return []
  const normalized = query.toLowerCase()
  return props.mentionOptions.filter(option => option.name.toLowerCase().includes(normalized)).slice(0, 8)
})
const mentionOpen = computed(() => mentionQuery.value !== null && filteredMentions.value.length > 0)

watch(filteredMentions, () => { mentionIndex.value = 0 })

function refreshMentionState() {
  void nextTick(() => {
    const input = inputRef.value
    if (!input || !props.mentionOptions.length) {
      mentionQuery.value = null
      mentionStart.value = -1
      return
    }
    const caret = input.selectionStart ?? prompt.value.length
    const match = prompt.value.slice(0, caret).match(/@([^\s@]*)$/)
    const start = match ? caret - match[0].length : -1
    // `@` 必须出现在 token 边界：行首或非单词字符之后，避免邮箱/句柄里的
    // `user@x`、`@@x` 触发补全。
    const validStart = match && (start === 0 || !MENTION_LEFT_TOKEN.test(prompt.value.charAt(start - 1)))
    mentionQuery.value = match && validStart ? match[1]! : null
    mentionStart.value = match && validStart ? start : -1
    if (!match) mentionIndex.value = 0
  })
}

function applyMention(option: { id: string; name: string }) {
  const input = inputRef.value
  const caret = input?.selectionStart ?? prompt.value.length
  const start = mentionStart.value >= 0 ? mentionStart.value : caret
  prompt.value = `${prompt.value.slice(0, start)}@${option.name} ${prompt.value.slice(caret)}`
  appliedMentions.value.push({ id: option.id, name: option.name, start })
  const nextCaret = start + option.name.length + 2
  void nextTick(() => {
    input?.focus()
    input?.setSelectionRange(nextCaret, nextCaret)
  })
  mentionStart.value = -1
}

const MENTION_BOUNDARY = String.raw`[\s,，。！？!?；;：:]`
/** `@` 左侧若是单词字符/`.`/`@`/`-`，说明它嵌在邮箱、句柄等 token 内部，不算提及起点。 */
const MENTION_LEFT_TOKEN = /[\w.@-]/

function findMentionPositions(text: string, name: string) {
  const pattern = new RegExp(`@${escapeRegExp(name)}(?=$|${MENTION_BOUNDARY})`, 'g')
  const positions: number[] = []
  for (const match of text.matchAll(pattern)) {
    const pos = match.index ?? 0
    if (pos > 0 && MENTION_LEFT_TOKEN.test(text.charAt(pos - 1))) continue
    positions.push(pos)
  }
  return positions
}

function resolveMentions(text: string) {
  // `@名称` 后必须紧跟空白/中英文标点或结尾，避免「@助手汇总」误命中「@助手」；
  // `@` 左侧不能紧跟单词字符，避免 `user@example.com` / `@@助手` 误判。
  const resolved: Array<{ id: string; pos: number }> = []
  const retained: typeof appliedMentions.value = []
  const claimedPositions = new Set<number>()
  for (const applied of appliedMentions.value) {
    const option = props.mentionOptions.find(item => item.id === applied.id)
    if (!option || option.name !== applied.name) continue
    const positions = findMentionPositions(text, applied.name)
    let pos = positions.includes(applied.start) ? applied.start : undefined
    // 文本在提及前插入会导致位置整体漂移；只有该名称在候选成员中唯一时才
    // 跟随。重名成员下，旧位置无法区分「前面插入了文本」和「删掉后又在别处
    // 输入同名文本」，此时交给兜底扫描按候选顺序消歧，避免旧选择错误跟随。
    const sameNameOptions = props.mentionOptions.filter(item => item.name === applied.name)
    if (
      pos === undefined
      && sameNameOptions.length === 1
      && positions.length === 1
      && !claimedPositions.has(positions[0]!)
    ) {
      pos = positions[0]
    }
    if (pos === undefined || claimedPositions.has(pos)) continue
    resolved.push({ id: applied.id, pos })
    retained.push({ ...applied, start: pos })
    claimedPositions.add(pos)
  }
  appliedMentions.value = retained
  // 兜底扫描只用于未登记的提及；同名成员重名时按 mentionOptions 顺序取首个，
  // 下拉选择的提及已通过上面的位置回放/唯一位置跟随消歧到用户实际点击的成员。
  for (const option of props.mentionOptions) {
    for (const pos of findMentionPositions(text, option.name)) {
      if (claimedPositions.has(pos)) continue
      resolved.push({ id: option.id, pos })
      claimedPositions.add(pos)
    }
  }
  return [...new Set(resolved.sort((a, b) => a.pos - b.pos).map(item => item.id))]
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const canSubmit = computed(() => (
  prompt.value.trim().length > 0
  && !props.submitting
  && !props.running
  && !props.blockedReason
))
const workspaceLabel = computed(() => {
  const selected = props.workspaces.find(workspace => workspace.id === workspaceId.value)
  if (selected) return selected.name
  if (workspaceId.value === props.initialWorkspaceId && props.initialWorkspaceName) return props.initialWorkspaceName
  return '我的空间'
})

watch(
  () => props.initialWorkspaceId,
  (next, previous) => {
    if (!workspaceId.value || workspaceId.value === previous) workspaceId.value = next
  },
)
function openFilePicker() {
  fileInput.value?.click()
}

function acceptFiles(fileList: FileList | File[]) {
  const incoming = Array.from(fileList)
  const allowedExtensions = ['pdf', 'docx', 'xlsx', 'csv', 'txt', 'md']
  for (const file of incoming) {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!allowedExtensions.includes(extension)) {
      ElMessage.warning(`${file.name} 暂不支持，当前版本支持 PDF、DOCX、XLSX、CSV、TXT 和 Markdown`)
      continue
    }
    if (file.size > 20 * 1024 * 1024) {
      ElMessage.warning(`${file.name} 超过 20 MB 的单文件限制`)
      continue
    }
    if (files.value.length >= 5) {
      ElMessage.warning('每次对话最多添加 5 个文件')
      break
    }
    if (!files.value.some(selected => selected.name === file.name && selected.size === file.size)) files.value.push(file)
  }
}

function onFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  if (target.files) acceptFiles(target.files)
  target.value = ''
}

function onDrop(event: DragEvent) {
  isDragging.value = false
  if (event.dataTransfer?.files) acceptFiles(event.dataTransfer.files)
}

function removeFile(file: File) {
  files.value = files.value.filter((selected) => selected !== file)
}

function insertReference(reference: string) {
  const spacer = prompt.value && !prompt.value.endsWith(' ') ? ' ' : ''
  prompt.value = `${prompt.value}${spacer}${reference} `
  void nextTick(() => inputRef.value?.focus())
}

function onAddCommand(command: string | number | object) {
  const value = String(command)
  if (value === 'upload') openFilePicker()
  if (value === 'workspace-file') insertReference('@工作空间文件')
  if (value === 'enterprise-data') insertReference('@企业数据')
}

function onWorkspaceCommand(command: string | number | object) {
  workspaceId.value = String(command)
}

function showVoiceMessage() {
  ElMessage.info('语音输入不在当前版本范围内，可继续使用文字或文件输入')
}

function submit() {
  if (!canSubmit.value) return
  const mentions = resolveMentions(prompt.value)
  // 团队会话里带附件的消息必须 @Agent 发起执行；拦截在组件内完成，
  // 保留输入与已选文件，避免发出后才发现附件被丢弃。
  if (props.filesRequireMention && files.value.length > 0 && mentions.length === 0) {
    ElMessage.warning('带附件的消息需要 @Agent 发起执行；纯讨论消息不支持附件。')
    return
  }
  emit('submit', {
    prompt: prompt.value.trim(),
    files: [...files.value],
    workspaceId: workspaceId.value,
    mentions,
    confirm: clearComposer,
  })
}

function clearComposer() {
  prompt.value = ''
  files.value = []
  mentionQuery.value = null
  appliedMentions.value = []
}

function onKeydown(event: KeyboardEvent) {
  if (mentionOpen.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      mentionIndex.value = (mentionIndex.value + delta + filteredMentions.value.length) % filteredMentions.value.length
      return
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing)) {
      event.preventDefault()
      const option = filteredMentions.value[mentionIndex.value] ?? filteredMentions.value[0]
      if (option) applyMention(option)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      mentionQuery.value = null
      return
    }
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  if (props.running) return
  event.preventDefault()
  submit()
}

function performPrimaryAction() {
  if (props.running) {
    if (!props.stopping) emit('stop')
    return
  }
  submit()
}
</script>

<template>
  <section
    class="composer"
    :class="{ 'composer--compact': compact, 'composer--dragging': isDragging }"
    @dragenter.prevent="isDragging = true"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="isDragging = false"
    @drop.prevent="onDrop"
  >
    <div v-if="isDragging" class="composer__drop-hint">
      <el-icon><Files /></el-icon>
      松开即可添加文件
    </div>

    <div class="composer__surface">
      <div v-if="files.length" class="composer__files" aria-label="已选择文件">
        <span v-for="file in files" :key="`${file.name}:${file.size}:${file.lastModified}`" class="file-chip">
          <el-icon><Paperclip /></el-icon>
          <span>{{ file.name }}</span>
          <button type="button" :aria-label="`移除 ${file.name}`" @click="removeFile(file)">
            <el-icon><Close /></el-icon>
          </button>
        </span>
      </div>

      <div v-if="selectedSkillName" class="composer__skill-reference" aria-label="已选择 Skill">
        <span>@{{ selectedSkillName }}</span>
        <button type="button" aria-label="移除已选择 Skill" @click="emit('clear-skill')">
          <el-icon><Close /></el-icon>
        </button>
      </div>

      <textarea
        ref="inputRef"
        v-model="prompt"
        class="composer__input"
        :rows="compact ? 2 : 4"
        aria-label="对话输入"
        :placeholder="
          compact
            ? '继续提问，可 @ 提及 Agent 或引用对话文件…'
            : '今天想完成什么？可 @ 提及 Agent、引用企业数据，或从左下角添加文件'
        "
        @keydown="onKeydown"
        @input="refreshMentionState"
        @keyup="refreshMentionState"
        @click="refreshMentionState"
      ></textarea>

      <div
        v-if="mentionOpen"
        class="composer__mentions"
        role="listbox"
        aria-label="提及 Agent"
        data-testid="mention-options"
      >
        <button
          v-for="(option, index) in filteredMentions"
          :key="option.id"
          type="button"
          role="option"
          class="composer__mention-option"
          :class="{ 'composer__mention-option--active': index === mentionIndex }"
          :aria-selected="index === mentionIndex"
          @mousedown.prevent="applyMention(option)"
        >
          <span class="composer__mention-at">@</span>
          <span>{{ option.name }}</span>
        </button>
      </div>

      <div class="composer__action-row">
        <div class="composer__leading-actions">
          <input
            ref="fileInput"
            class="composer__file-input"
            type="file"
            multiple
            accept=".pdf,.docx,.xlsx,.csv,.txt,.md"
            @change="onFileChange"
          />
          <el-dropdown trigger="click" placement="top-start" @command="onAddCommand">
            <button class="composer__icon-action" type="button" aria-label="添加内容">
              <el-icon><Plus /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="upload">
                  <el-icon><Paperclip /></el-icon>
                  上传本地文件
                </el-dropdown-item>
                <el-dropdown-item command="workspace-file">
                  <el-icon><FolderOpened /></el-icon>
                  引用工作空间文件
                </el-dropdown-item>
                <el-dropdown-item command="enterprise-data">
                  <el-icon><Search /></el-icon>
                  引用企业数据
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <span
            v-if="compact"
            class="composer__compact-trust"
            aria-label="按企业身份和工作空间权限执行"
          >
            <el-icon><Lock /></el-icon>
            <span>按企业权限执行</span>
          </span>
          <span v-if="files.length" class="composer__file-count">{{ files.length }} 个文件</span>
        </div>

        <p v-if="blockedReason" data-testid="composer-blocked" class="composer__blocked">
          {{ blockedReason }}
        </p>

        <div class="composer__trailing-actions">
          <button
            class="composer__icon-action composer__voice"
            type="button"
            aria-label="语音输入"
            @click="showVoiceMessage"
          >
            <el-icon><Microphone /></el-icon>
          </button>
          <button
            class="composer__send"
            :class="{ 'composer__send--stop': running }"
            type="button"
            :aria-label="running ? (stopping ? '正在停止本轮执行' : '停止本轮执行') : '发送消息'"
            :title="running ? (stopping ? '正在停止' : '停止本轮执行') : '发送消息'"
            :aria-busy="running ? stopping : submitting"
            :disabled="running ? stopping : !canSubmit"
            @click="performPrimaryAction"
          >
            <el-icon :class="{ 'is-loading': submitting || stopping }">
              <Loading v-if="submitting || stopping" />
              <VideoPause v-else-if="running" />
              <ArrowUp v-else />
            </el-icon>
          </button>
        </div>
      </div>
    </div>

    <div v-if="!compact" class="composer__context-bar">
      <div class="composer__context-controls">
        <span
          v-if="workspaceLocked"
          class="context-control context-control--locked"
          aria-label="当前工作空间"
        >
          <el-icon><FolderOpened /></el-icon>
          <span>{{ workspaceLabel }}</span>
          <el-icon class="composer__chevron"><Lock /></el-icon>
        </span>
        <el-dropdown v-else trigger="click" @command="onWorkspaceCommand">
          <button class="context-control" type="button" aria-label="选择工作空间">
            <el-icon><FolderOpened /></el-icon>
            <span>{{ workspaceLabel }}</span>
            <el-icon class="composer__chevron"><ArrowDown /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="workspace in workspaces"
                :key="workspace.id"
                :command="workspace.id"
              >
                {{ workspace.name }}{{ workspace.type === 'personal' ? '（个人）' : '' }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <span class="composer__trust-note">
        <el-icon><Lock /></el-icon>
        按企业身份和工作空间权限执行
      </span>
    </div>
  </section>
</template>

<style scoped>
.composer {
  position: relative;
  width: 100%;
  border-radius: 17px;
  transition: box-shadow 160ms ease;
}

.composer__surface {
  overflow: hidden;
  border: 1px solid #dedfdd;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 10px 30px rgb(24 25 24 / 6%);
  transition: border-color 160ms ease, box-shadow 160ms ease;
}

.composer__mentions {
  display: flex;
  max-height: 216px;
  flex-direction: column;
  margin: 0 12px 8px;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid #e3e6e2;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 6px 20px rgb(35 45 40 / 8%);
}

.composer__mention-option {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  color: #3a3f3a;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
  text-align: left;
}

.composer__mention-option:hover,
.composer__mention-option--active {
  color: #175e4d;
  background: #f0f7f4;
}

.composer__mention-at {
  display: grid;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 6px;
  color: #fff;
  background: #3e5f55;
  font-size: var(--dsh-font-size-micro);
  font-weight: 700;
}

.composer:focus-within .composer__surface {
  border-color: #b8bbb7;
  box-shadow: 0 0 0 3px rgb(55 92 79 / 5%), 0 12px 34px rgb(24 25 24 / 7%);
}

.composer--compact .composer__surface {
  border-radius: 12px;
  box-shadow: none;
}

.composer--dragging .composer__surface {
  border-color: #4ba98c;
  box-shadow: 0 0 0 4px rgb(75 169 140 / 10%);
}

.composer__drop-hint {
  position: absolute;
  z-index: 4;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  border-radius: 16px;
  color: #18715a;
  background: rgb(244 250 248 / 96%);
  font-size: var(--dsh-font-size-subheading);
  font-weight: 650;
}

.composer__input {
  display: block;
  width: 100%;
  min-height: 116px;
  padding: 18px 17px 8px;
  resize: none;
  border: 0;
  outline: 0;
  color: #222522;
  background: transparent;
  font-size: var(--dsh-font-size-body);
  line-height: 1.7;
}

.composer--compact .composer__input {
  min-height: 72px;
  padding: 15px 15px 7px;
}

.composer__input::placeholder {
  color: #969a96;
}

.composer__files {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  padding: 13px 13px 0;
}

.composer__files + .composer__input {
  padding-top: 8px;
}

.composer--compact .composer__files {
  padding: 11px 11px 0;
}

.composer--compact .composer__files + .composer__input {
  padding-top: 7px;
}

.composer__skill-reference {
  display: inline-flex;
  align-items: center;
  max-width: calc(100% - 26px);
  gap: 5px;
  margin: 12px 13px 0;
  padding: 5px 6px 5px 11px;
  border: 1px solid #c9e6d9;
  border-radius: 999px;
  color: #23644f;
  background: #f0faf5;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.35;
}

.composer__skill-reference > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer__skill-reference button {
  display: grid;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 50%;
  color: #5f8b7b;
  background: transparent;
  cursor: pointer;
}

.composer__skill-reference button:hover {
  color: #23644f;
  background: #d9efe5;
}

.composer__skill-reference + .composer__input {
  padding-top: 8px;
}

.composer--compact .composer__skill-reference {
  margin: 10px 11px 0;
}

.file-chip {
  display: inline-flex;
  align-items: center;
  max-width: 280px;
  min-height: 29px;
  gap: 6px;
  padding: 3px 5px 3px 8px;
  border: 1px solid #dedfdd;
  border-radius: 7px;
  color: #4e554f;
  background: #f7f8f6;
  font-size: var(--dsh-font-size-caption);
}

.file-chip > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-chip button {
  display: grid;
  width: 20px;
  height: 20px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 5px;
  color: #818681;
  background: transparent;
  cursor: pointer;
}

.file-chip button:hover {
  color: #a6313e;
  background: #ffedef;
}

.composer__action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 50px;
  gap: 12px;
  padding: 7px 10px 10px 11px;
}

.composer__leading-actions,
.composer__trailing-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.composer__file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

.composer__icon-action,
.composer__send,
.context-control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  color: #4f544f;
  background: transparent;
  cursor: pointer;
}

.composer__icon-action {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  font-size: var(--dsh-font-size-section);
}

.composer__icon-action:hover,
.context-control:hover {
  color: #202320;
  background: #f0f1ef;
}

.composer__file-count,
.composer__shortcut-hint {
  margin-left: 3px;
  color: #858a85;
  font-size: var(--dsh-font-size-badge);
}

.composer__compact-trust {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 4px;
  color: #858a85;
  font-size: var(--dsh-font-size-badge);
}

.composer__chevron {
  font-size: var(--dsh-font-size-badge);
}

.composer__voice {
  color: #696e69;
}

.composer__send {
  width: 33px;
  height: 33px;
  margin-left: 2px;
  border-radius: 50%;
  color: #fff;
  background: #242724;
  font-size: var(--dsh-font-size-section);
  transition: transform 140ms ease, background 140ms ease;
}

.composer__blocked {
  margin: 6px 0 0;
  color: var(--dsh-color-warning, #b88230);
  font-size: var(--dsh-font-size-badge);
}

.composer__send:not(:disabled):hover {
  transform: translateY(-1px);
  background: #0f5f4c;
}

.composer__send--stop {
  background: #a63d48;
}

.composer__send--stop:not(:disabled):hover {
  background: #8f2f3a;
}

.composer__send:disabled {
  color: #f7f7f6;
  background: #b7bab7;
  cursor: not-allowed;
}

.composer__context-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 38px;
  gap: 14px;
  margin: -2px 1px 0;
  padding: 5px 11px 4px;
  border-radius: 0 0 15px 15px;
  color: #777c77;
  background: #f4f5f3;
}

.composer__context-controls {
  display: flex;
  min-width: 0;
  align-items: center;
}

.context-control {
  min-width: 0;
  min-height: 28px;
  gap: 6px;
  padding: 0 7px;
  border-radius: 7px;
  color: #747974;
  font-size: var(--dsh-font-size-badge);
}

.context-control span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-control--locked {
  color: #315f52;
  background: #eaf5f1;
  cursor: default;
}

.context-control--locked:hover {
  color: #315f52;
  background: #eaf5f1;
}

.composer__trust-note {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  color: #8b8f8b;
  font-size: var(--dsh-font-size-micro);
}

@media (max-width: 640px) {
  .composer__input {
    min-height: 104px;
  }

  .composer__context-bar {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
    padding: 7px 8px;
  }

  .composer__context-controls {
    width: 100%;
  }

  .composer__context-controls > * {
    min-width: 0;
  }

  .context-control {
    max-width: 160px;
  }

  .composer__trust-note {
    margin-left: 7px;
  }

  .composer__compact-trust span {
    display: none;
  }

  .composer__shortcut-hint {
    display: none;
  }
}
</style>
