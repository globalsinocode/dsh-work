<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled } from '@element-plus/icons-vue'

import { useAgentGovernanceStore, type ZipInspection } from '@/stores/agentGovernance'
import type { AgentDefinition } from '@/types/domain'

const emit = defineEmits<{
  saved: [agent: AgentDefinition, info: ZipInspection]
}>()

const governance = useAgentGovernanceStore()

const fileName = ref('')
const selectedFile = ref<File>()
const info = ref<ZipInspection>()
const inspecting = ref(false)
const importing = ref(false)

const parsed = computed(() => Boolean(info.value))
/** 声明依赖是否全部解析到平台已发布能力。 */
const fullyResolved = computed(() =>
  Boolean(info.value && !info.value.missing.skills.length && !info.value.missing.tools.length),
)
const hasPackageCandidates = computed(() =>
  Boolean(info.value && (info.value.packageRefs.skills.length || info.value.packageRefs.tools.length)),
)

async function onFileChange(file: { raw?: File }) {
  info.value = undefined
  selectedFile.value = undefined
  fileName.value = file.raw?.name ?? ''
  if (!file.raw) return
  // 损坏、空包或非法格式的 ZIP 直接拒绝（服务端仍做完整安全解包校验）。
  if (!file.raw.name.toLowerCase().endsWith('.zip') || file.raw.size === 0) {
    ElMessage.error('ZIP 包损坏或格式无效，已拒绝导入')
    return
  }
  inspecting.value = true
  try {
    info.value = await governance.inspectPackage(file.raw)
    selectedFile.value = file.raw
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '包解析失败')
  } finally {
    inspecting.value = false
  }
}

async function importAsDraft() {
  const file = selectedFile.value
  const inspection = info.value
  if (!file || !inspection || importing.value) return
  importing.value = true
  try {
    const { agent } = await governance.importPackage(file)
    emit('saved', agent, inspection)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '导入失败')
  } finally {
    importing.value = false
  }
}

defineExpose({ parsed, importing, importAsDraft })
</script>

<template>
  <section class="zip-import" aria-label="ZIP 导入">
    <el-upload
      drag
      :auto-upload="false"
      :limit="1"
      accept=".zip"
      :show-file-list="false"
      :on-change="onFileChange"
    >
      <el-icon class="zip-import__icon"><UploadFilled /></el-icon>
      <div class="el-upload__text">拖拽 agent-package ZIP 到此处，或 <em>点击选择文件</em></div>
      <template #tip>
        <div class="el-upload__tip">最小包：agent.yaml + prompts/system.md；可选 evals/cases.yaml（缺省时平台自动生成试运行案例）。服务端安全解包，不执行安装钩子。</div>
      </template>
    </el-upload>

    <div v-if="inspecting" class="zip-import__preview"><el-skeleton :rows="4" animated /></div>
    <div v-else-if="info" class="zip-import__preview">
      <h4>解析预览 · {{ info.fileName }}</h4>
      <dl class="zip-import__meta">
        <div><dt>标识</dt><dd class="mono">{{ info.manifest.id }}</dd></div>
        <div><dt>名称</dt><dd>{{ info.manifest.name }}</dd></div>
        <div><dt>来源版本</dt><dd class="mono">v{{ info.manifest.version }}</dd></div>
        <div class="zip-import__meta-wide"><dt>说明</dt><dd>{{ info.manifest.description }}</dd></div>
      </dl>
      <el-collapse>
        <el-collapse-item title="文件清单" name="files">
          <div class="zip-import__files"><span v-for="file in info.files" :key="file" class="mono">{{ file }}</span></div>
        </el-collapse-item>
        <el-collapse-item title="已解析引用（agent.yaml 声明的依赖）" name="resolved">
          <div class="zip-import__files">
            <span v-for="reference in [...info.resolved.skills, ...info.resolved.tools]" :key="reference" class="mono">{{ reference }}</span>
            <span v-if="!info.resolved.skills.length && !info.resolved.tools.length" class="muted">声明的依赖均未在平台解析到已发布版本</span>
          </div>
          <div v-if="info.missing.skills.length || info.missing.tools.length" class="zip-import__missing">
            <span class="zip-import__missing-label">缺少：</span>
            <span v-for="reference in [...info.missing.skills, ...info.missing.tools]" :key="reference" class="mono zip-import__missing-ref">{{ reference }}</span>
          </div>
        </el-collapse-item>
        <el-collapse-item :title="`试运行案例（${info.cases.length} 条）`" name="cases">
          <div class="zip-import__files">
            <span v-for="item in info.cases" :key="item.name" class="mono">{{ item.name }} · {{ item.kind }}</span>
            <span v-if="!info.cases.length" class="muted">包内未提供 evals/cases.yaml，导入后按 Agent 定义自动生成三类默认案例</span>
          </div>
        </el-collapse-item>
      </el-collapse>
      <h4>包内候选</h4>
      <div class="zip-import__files">
        <span v-for="item in info.packageRefs.skills" :key="item.id" class="mono">{{ item.id }}@{{ item.version }}（{{ item.path }}）</span>
        <span v-for="item in info.packageRefs.tools" :key="item.id" class="mono">{{ item.id }}@{{ item.version }}（{{ item.path }}）</span>
        <span v-if="!hasPackageCandidates" class="muted">无包内候选</span>
      </div>
      <el-alert v-for="warning in info.warnings" :key="warning" class="zip-import__warning" type="warning" :closable="false" :title="warning" />
      <p class="zip-import__hint">
        {{ fullyResolved ? '依赖已全部解析，导入后可进入检查与试运行。' : '导入为草稿后，可在「定义与依赖」页处理缺失依赖；缺失项会阻塞试运行。' }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.zip-import__icon { color: var(--color-text-muted); font-size: 42px; }
.zip-import__preview { margin-top: 14px; }
.zip-import__preview h4 { margin: 14px 0 8px; color: var(--color-text-heading); font-size: var(--font-size-caption); }
.zip-import__preview h4:first-child { margin-top: 0; }
.zip-import__meta { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px; margin: 0; }
.zip-import__meta-wide { grid-column: 1 / -1; }
.zip-import__meta dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.zip-import__meta dd { margin: 3px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); }
.zip-import__files { display: flex; flex-wrap: wrap; gap: 6px; }
.zip-import__files span { padding: 3px 9px; border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text-secondary); background: var(--color-bg-subtle); font-size: var(--font-size-badge); }
.zip-import__warning { margin-top: 8px; }
.zip-import__hint { margin: 10px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.zip-import__missing { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
.zip-import__missing-label { color: var(--color-danger-strong); font-size: var(--font-size-badge); }
.zip-import__missing-ref { border-color: var(--color-danger) !important; color: var(--color-danger-strong) !important; }
.mono { font-family: monospace; }
.muted { color: var(--color-text-muted); font-size: var(--font-size-badge); }
</style>
