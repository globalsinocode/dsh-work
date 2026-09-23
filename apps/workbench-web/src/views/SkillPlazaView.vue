<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChatDotRound, MagicStick, Refresh } from '@element-plus/icons-vue'

import { useContentStore } from '@/stores/content'
import type { WorkbenchSkill } from '@/types/domain'

const router = useRouter()
const contentStore = useContentStore()
const loading = ref(true)
const errorMessage = ref('')
const activeCategory = ref('全部')
const detailSkill = ref<WorkbenchSkill>()
const detailOpen = ref(false)

const categories = computed(() => [
  '全部',
  ...new Set(contentStore.skills.map(skill => skill.category).filter(Boolean)),
])

const visibleSkills = computed(() => contentStore.skills.filter((skill) =>
  activeCategory.value === '全部' || skill.category === activeCategory.value,
))

function useSkill(skill: WorkbenchSkill) {
  void router.push({ path: '/workbench', query: { skill: skill.id } })
}

function showDetails(skill: WorkbenchSkill) {
  detailSkill.value = skill
  detailOpen.value = true
}

async function loadSkills() {
  loading.value = true
  errorMessage.value = ''
  try {
    await contentStore.refreshSkills()
    if (!categories.value.includes(activeCategory.value)) activeCategory.value = '全部'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Skill 加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(loadSkills)
</script>

<template>
  <div class="skill-plaza-page">
    <nav class="skill-category-tabs" aria-label="Skill 分类筛选">
      <button
        v-for="category in categories"
        :key="category"
        type="button"
        class="skill-category-tab"
        :class="{ 'is-active': activeCategory === category }"
        :aria-current="activeCategory === category ? 'page' : undefined"
        @click="activeCategory = category"
      >
        {{ category }}
      </button>
    </nav>

    <div v-if="loading" class="skill-card-grid" aria-label="正在加载 Skill">
      <div v-for="index in 6" :key="index" class="skill-card skill-card--skeleton">
        <el-skeleton :rows="4" animated />
      </div>
    </div>

    <el-result
      v-else-if="errorMessage"
      class="skill-state"
      icon="warning"
      title="Skill 暂时无法加载"
      :sub-title="errorMessage"
    >
      <template #extra>
        <el-button type="primary" :icon="Refresh" @click="loadSkills">重新加载</el-button>
      </template>
    </el-result>

    <el-empty v-else-if="!visibleSkills.length" class="skill-state" description="当前分类没有已发布的 Skill" />

    <div v-else class="skill-card-grid" aria-label="Skill 列表">
      <article v-for="skill in visibleSkills" :key="skill.id" class="skill-card">
        <div class="skill-card__heading">
          <span class="skill-card__icon" aria-hidden="true"><el-icon><MagicStick /></el-icon></span>
          <div class="skill-card__title">
            <h2>{{ skill.name }}</h2>
          </div>
          <button
            type="button"
            class="catalog-add-button"
            :aria-label="`使用 Skill：${skill.name}`"
            @click="useSkill(skill)"
          >
            <el-icon><ChatDotRound /></el-icon>
            <span>去对话</span>
          </button>
        </div>
        <p class="skill-card__description">{{ skill.description }}</p>
        <div class="skill-card__footer">
          <el-tag size="small" effect="plain">{{ skill.category }}</el-tag>
          <button type="button" class="skill-card__detail" @click="showDetails(skill)">查看详情</button>
        </div>
      </article>
    </div>

    <el-drawer v-model="detailOpen" title="Skill 详情" size="min(440px, 92vw)">
      <template v-if="detailSkill">
        <div class="skill-detail">
          <div class="skill-detail__header">
            <span class="skill-card__icon"><el-icon><MagicStick /></el-icon></span>
            <div>
              <h2>{{ detailSkill.name }}</h2>
              <p>v{{ detailSkill.version }} · {{ detailSkill.owner }}</p>
            </div>
          </div>
          <el-tag size="small" effect="plain">{{ detailSkill.category }}</el-tag>
          <p class="skill-detail__description">{{ detailSkill.description }}</p>
          <div class="skill-detail__prompt">
            <span>推荐提问</span>
            <p>{{ detailSkill.testPrompt }}</p>
          </div>
          <el-button type="primary" class="skill-detail__use" @click="useSkill(detailSkill)">使用 Skill</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.skill-plaza-page {
  min-height: 100vh;
  padding: 24px clamp(18px, 3vw, 44px) 48px;
  color: #282a29;
  background: #fff;
}

.skill-category-tabs {
  display: flex;
  gap: 4px;
  width: 100%;
  margin-bottom: 18px;
  overflow-x: auto;
  scrollbar-width: none;
}

.skill-category-tabs::-webkit-scrollbar { display: none; }

.skill-category-tab {
  flex: 0 0 auto;
  padding: 8px 13px;
  border: 0;
  border-radius: 8px;
  color: #727672;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
  white-space: nowrap;
}

.skill-category-tab:hover { color: #222522; background: #f3f3f1; }
.skill-category-tab.is-active { color: #171817; background: #ededeb; font-weight: 650; }

.skill-card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.skill-card {
  display: flex;
  min-height: 172px;
  flex-direction: column;
  padding: 20px;
  border: 1px solid #e8eae8;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 8px 24px rgb(35 48 40 / 4%);
  transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease;
}

.skill-card:hover { border-color: #c7e0d4; box-shadow: 0 12px 28px rgb(35 80 60 / 9%); transform: translateY(-2px); }
.skill-card--skeleton { min-height: 184px; }

.skill-card__heading,
.skill-detail__header { display: flex; align-items: center; gap: 10px; }
.skill-card__icon { display: grid; width: 38px; height: 38px; flex: 0 0 auto; place-items: center; border-radius: 11px; color: #19765a; background: #e5f5ed; font-size: var(--dsh-font-size-header); }
.skill-card__title { min-width: 0; flex: 1; }
.skill-card__title h2 { margin: 0; overflow: hidden; color: #222522; font-size: var(--dsh-font-size-body); font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.catalog-add-button { display: inline-flex; min-width: 78px; height: 36px; flex: 0 0 auto; align-items: center; justify-content: center; gap: 5px; padding: 0 10px; border: 0; border-radius: 9px; color: #242624; background: #f1f2f0; cursor: pointer; font-size: var(--dsh-font-size-caption); font-weight: 620; transition: background 140ms ease, transform 140ms ease; }
.catalog-add-button .el-icon { font-size: var(--dsh-font-size-body); }
.catalog-add-button:hover { background: #e4eee9; transform: scale(1.04); }
.catalog-add-button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.skill-card__description { display: -webkit-box; min-height: 44px; margin: 15px 0 13px; overflow: hidden; color: #666c67; font-size: var(--dsh-font-size-caption); line-height: 1.65; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.skill-card__footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: auto; }
.skill-card__detail { padding: 0; border: 0; color: #6a746d; background: transparent; cursor: pointer; font-size: var(--dsh-font-size-caption); }
.skill-card__detail:hover { color: #17674f; }
.skill-card__footer .el-tag { border-color: #e3e7e4; color: #69716c; background: #f7f8f7; }
.skill-state { min-height: 360px; }

.skill-detail { display: flex; flex-direction: column; gap: 18px; }
.skill-detail__header h2 { margin: 0; color: #222522; font-size: var(--dsh-font-size-section); }
.skill-detail__header p { margin: 5px 0 0; color: #899089; font-size: var(--dsh-font-size-caption); }
.skill-detail__description { margin: 0; color: #555d57; font-size: var(--dsh-font-size-body); line-height: 1.7; }
.skill-detail__prompt { padding: 14px; border-radius: 10px; background: #f4f8f5; }
.skill-detail__prompt span { color: #6c8578; font-size: var(--dsh-font-size-micro); }
.skill-detail__prompt p { margin: 7px 0 0; color: #345d4c; line-height: 1.6; }
.skill-detail__use { align-self: flex-start; }

@media (max-width: 1080px) { .skill-card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 820px) { .skill-plaza-page { padding-top: 64px; } }
@media (max-width: 640px) {
  .skill-plaza-page { padding: 64px 13px 32px; }
  .skill-card-grid { grid-template-columns: 1fr; gap: 12px; }
  .skill-card { min-height: 168px; }
}
</style>
