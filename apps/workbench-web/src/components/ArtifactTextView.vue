<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { parseArtifactText, TEXT_PREVIEW_HINTS, type OfficeArtifactType } from '@/utils/artifact-preview'

/**
 * 执行隔离 2b-5：Office/PDF 成果的解析文本。表格按工作表显示为表格（气泡内用标签切换、
 * 预览对话框中依次列出），演示稿按页列出，其他按原文换行显示；顶部说明解析文本不含什么。
 */
const props = withDefaults(defineProps<{
  type: OfficeArtifactType
  text: string
  layout?: 'tabs' | 'stacked'
}>(), { layout: 'tabs' })

const parsed = computed(() => parseArtifactText(props.type, props.text))
const activeSheet = ref(0)
watch(() => props.text, () => { activeSheet.value = 0 })

const sheets = computed(() => {
  if (parsed.value.kind !== 'sheets') return []
  return parsed.value.sheets.map((sheet) => {
    const columns = Math.max(sheet.header.length, ...sheet.rows.map(row => row.length), 0)
    const pad = (cells: string[]) => [...cells, ...Array<string>(columns - cells.length).fill('')]
    return { name: sheet.name, header: sheet.header.length ? pad(sheet.header) : [], rows: sheet.rows.map(pad) }
  })
})
const visibleSheets = computed(() => props.layout === 'tabs' ? sheets.value.slice(activeSheet.value, activeSheet.value + 1) : sheets.value)
</script>

<template>
  <div class="artifact-text" :data-testid="`artifact-text-${type}`">
    <p class="artifact-text__hint">{{ TEXT_PREVIEW_HINTS[type] }}</p>

    <template v-if="parsed.kind === 'sheets'">
      <div v-if="layout === 'tabs' && sheets.length > 1" class="artifact-text__tabs" aria-label="工作表">
        <button
          v-for="(sheet, index) in sheets"
          :key="`${index}-${sheet.name}`"
          type="button"
          class="artifact-text__tab"
          :class="{ 'artifact-text__tab--active': index === activeSheet }"
          :aria-pressed="index === activeSheet"
          @click="activeSheet = index"
        >
          {{ sheet.name }}
        </button>
      </div>
      <section
        v-for="sheet in visibleSheets"
        :key="sheet.name"
        class="artifact-text__sheet"
        :aria-label="`工作表 ${sheet.name}`"
      >
        <h4 v-if="layout === 'stacked' || sheets.length === 1" class="artifact-text__sheet-title">工作表：{{ sheet.name }}</h4>
        <div v-if="sheet.header.length" class="artifact-text__table-wrap">
          <table class="artifact-text__table">
            <thead>
              <tr><th v-for="(cell, index) in sheet.header" :key="index" scope="col">{{ cell }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(row, rowIndex) in sheet.rows" :key="rowIndex">
                <td v-for="(cell, index) in row" :key="index">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="artifact-text__empty">此工作表没有内容</p>
      </section>
    </template>

    <ol v-else-if="parsed.kind === 'slides'" class="artifact-text__slides">
      <li v-for="slide in parsed.slides" :key="slide.no" class="artifact-text__slide">
        <span class="artifact-text__slide-no">第 {{ slide.no }} 页</span>
        <p v-for="(line, index) in slide.lines" :key="index">{{ line }}</p>
        <p v-for="(note, index) in slide.notes" :key="`note-${index}`" class="artifact-text__slide-note">备注：{{ note }}</p>
      </li>
    </ol>

    <div v-else class="artifact-text__plain">{{ parsed.text }}</div>
  </div>
</template>

<style scoped>
.artifact-text {
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: #2b302c;
}

.artifact-text__hint {
  margin: 0;
  color: #5f655f;
  font-size: var(--dsh-font-size-badge);
}

.artifact-text__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.artifact-text__tab {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #4c514c;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
}

.artifact-text__tab--active {
  border-color: #bdcbc5;
  color: #24493d;
  background: #ffffff;
  font-weight: 600;
}

.artifact-text__sheet {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.artifact-text__sheet-title {
  margin: 0;
  font-size: var(--dsh-font-size-caption);
}

.artifact-text__table-wrap {
  overflow-x: auto;
  border: 1px solid #eceeeb;
  border-radius: 8px;
}

.artifact-text__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--dsh-font-size-caption);
}

.artifact-text__table th,
.artifact-text__table td {
  padding: 6px 10px;
  border-bottom: 1px solid #eceeeb;
  text-align: left;
  white-space: nowrap;
}

.artifact-text__table th {
  color: #4c514c;
  background: #f4f6f4;
  font-weight: 600;
}

.artifact-text__empty {
  margin: 0;
  color: #6b716b;
  font-size: var(--dsh-font-size-badge);
}

.artifact-text__slides {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.artifact-text__slide {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid #eceeeb;
  border-radius: 8px;
  background: #fafbfa;
}

.artifact-text__slide p {
  margin: 0;
  font-size: var(--dsh-font-size-caption);
}

.artifact-text__slide-no,
.artifact-text__slide .artifact-text__slide-note {
  color: #6b716b;
  font-size: var(--dsh-font-size-badge);
}

.artifact-text__plain {
  font-size: var(--dsh-font-size-caption);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
