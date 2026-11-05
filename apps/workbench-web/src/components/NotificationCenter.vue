<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Bell, Close } from '@element-plus/icons-vue'

import { useCollabConversationStore } from '@/stores/collab-conversations'
import { useNotificationStore, type NotificationTab } from '@/stores/notifications'
import { useUiModeStore } from '@/stores/ui-mode'
import type { UserNotification } from '@/types/domain'
import { formatActivityTime } from '@/utils/activity-time'
import { notificationGlyph, notificationLocation, notificationPlainText, notificationText } from '@/utils/notifications'

/**
 * 站内通知入口（方案 NC-S2）：导航栏左下角头像上方的铃铛与紧贴导航栏展开的面板（NC2）。
 * 两种模式共用；面板左缘取所在导航栏的实际右缘，窄屏面板全屏。角标每分钟（页面可见时）与
 * 页面重新可见时刷新（不新增推送通道）。点一条标为已读并跳转；不可见的通知就地提示、不跳转。
 * 切换账号会整页重新加载（auth store），不需要在这里清理上一账号的状态。
 */
const props = withDefaults(defineProps<{
  /** 铃铛尺寸随所在导航栏：侧栏用小号，图标栏用大号。 */
  size?: 'small' | 'large'
}>(), { size: 'small' })

const emit = defineEmits<{ navigate: [] }>()

const router = useRouter()
const uiMode = useUiModeStore()
const notifications = useNotificationStore()
const conversations = useCollabConversationStore()
const open = ref(false)
const panel = ref<HTMLElement>()
const bell = ref<HTMLButtonElement>()
const panelLeft = ref('0px')

const badge = computed(() => (notifications.unread > 99 ? '99+' : String(notifications.unread)))
const bellLabel = computed(() => (notifications.unread > 0 ? `通知，${notifications.unread} 条未读` : '通知'))
const emptyText = computed(() => (notifications.tab === 'unread' ? '暂时没有未读通知' : '暂时没有通知'))

const pollIntervalMs = 60_000
let timer: ReturnType<typeof setInterval> | undefined

function onVisibilityChange() {
  if (document.visibilityState === 'visible') void notifications.refreshUnread()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) close()
}

/** 面板是模态的：Tab 在面板内循环，不进入遮罩后的页面。 */
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !panel.value) return
  const focusable = [...panel.value.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
  if (!focusable.length) return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function toggle() {
  if (open.value) {
    close()
    return
  }
  // 面板渲染在 body 下，导航栏的 CSS 变量传不过去，按铃铛所在导航栏的实际右缘定位。
  const nav = bell.value?.closest('aside')
  panelLeft.value = `${nav ? Math.round(nav.getBoundingClientRect().right) : 0}px`
  open.value = true
  void notifications.load()
  await nextTick()
  panel.value?.focus()
}

function close() {
  open.value = false
  bell.value?.focus()
}

function switchTab(next: NotificationTab) {
  if (next !== notifications.tab) void notifications.load(next)
}

/** 读过 @ 通知后，B 的对话列表（“[有人@我]”与导航圆点）随之更新（方案 NC4）。 */
function syncConversationMentions() {
  if (conversations.loaded) void conversations.refresh()
}

async function readAll() {
  try {
    const hadMention = notifications.items.some(item => item.kind === 'mention' && !item.read)
    await notifications.markAllRead()
    if (hadMention || conversations.hasMention) syncConversationMentions()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '标记已读失败，请稍后重试')
  }
}

async function openItem(item: UserNotification) {
  const location = notificationLocation(item, uiMode.mode)
  const wasUnreadMention = item.kind === 'mention' && !item.read
  void notifications.markRead(item).then(() => {
    if (wasUnreadMention) syncConversationMentions()
  })
  if (!location) {
    ElMessage.warning('该内容已不可见')
    return
  }
  open.value = false
  emit('navigate')
  await router.push(location)
}

function itemTime(item: UserNotification) {
  const time = formatActivityTime(item.createdAt)
  return item.visible && item.workspace ? `${time} · ${item.workspace.name}` : time
}

function itemLabel(item: UserNotification) {
  return `${item.read ? '' : '未读：'}${notificationPlainText(item)}，${itemTime(item)}`
}

onMounted(() => {
  void notifications.refreshUnread()
  // 页面在后台时不轮询，回到前台时由 visibilitychange 立即刷新。
  timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void notifications.refreshUnread()
  }, pollIntervalMs)
  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <button
    ref="bell"
    class="notification-bell"
    :class="[`notification-bell--${props.size}`, { 'notification-bell--open': open }]"
    type="button"
    :aria-label="bellLabel"
    :aria-expanded="open"
    aria-haspopup="dialog"
    data-testid="notification-bell"
    @click="toggle"
  >
    <el-icon aria-hidden="true"><Bell /></el-icon>
    <span v-if="notifications.unread > 0" class="notification-bell__badge" aria-hidden="true">{{ badge }}</span>
  </button>

  <Teleport to="body">
    <div v-if="open" class="notification-layer" :style="{ '--notification-panel-left': panelLeft }">
      <button class="notification-layer__scrim" type="button" aria-label="关闭通知面板" tabindex="-1" @click="close"></button>
      <section ref="panel" class="notification-panel" role="dialog" aria-label="通知" aria-modal="true" tabindex="-1" @keydown="trapFocus">
        <header class="notification-panel__header">
          <h2>通知</h2>
          <div class="notification-panel__actions">
            <el-button link type="primary" :disabled="notifications.unread === 0" @click="readAll">全部标为已读</el-button>
            <el-button link :icon="Close" aria-label="关闭通知" @click="close" />
          </div>
        </header>
        <div class="notification-panel__tabs" role="tablist" aria-label="通知筛选">
          <button
            id="notification-tab-all"
            role="tab"
            type="button"
            aria-controls="notification-tabpanel"
            :aria-selected="notifications.tab === 'all'"
            :class="{ 'is-active': notifications.tab === 'all' }"
            @click="switchTab('all')"
          >全部</button>
          <button
            id="notification-tab-unread"
            role="tab"
            type="button"
            aria-controls="notification-tabpanel"
            :aria-selected="notifications.tab === 'unread'"
            :class="{ 'is-active': notifications.tab === 'unread' }"
            @click="switchTab('unread')"
          >{{ notifications.unread > 0 ? `未读 ${badge}` : '未读' }}</button>
        </div>

        <div id="notification-tabpanel" class="notification-panel__body" role="tabpanel" :aria-labelledby="`notification-tab-${notifications.tab}`">
          <div v-if="notifications.loading && !notifications.items.length" class="notification-panel__state">正在加载…</div>
          <div v-else-if="notifications.error && !notifications.items.length" class="notification-panel__state" role="alert">
            <p>{{ notifications.error }}</p>
            <el-button size="small" @click="notifications.load()">重试</el-button>
          </div>
          <div v-else-if="!notifications.items.length" class="notification-panel__state">{{ emptyText }}</div>
          <ul v-else class="notification-list" aria-label="通知列表">
            <li v-for="item in notifications.items" :key="item.id">
              <button
                class="notification-item"
                :class="{ 'notification-item--unread': !item.read, 'notification-item--hidden': !item.visible }"
                type="button"
                :aria-label="itemLabel(item)"
                @click="openItem(item)"
              >
                <span class="notification-item__dot" aria-hidden="true"></span>
                <span class="notification-item__glyph" :class="`notification-item__glyph--${item.visible ? item.kind : 'hidden'}`" aria-hidden="true">{{ notificationGlyph(item) }}</span>
                <span class="notification-item__copy">
                  <span class="notification-item__text">
                    <template v-for="(part, index) in notificationText(item)" :key="index">
                      <strong v-if="part.strong">{{ part.text }}</strong><template v-else>{{ part.text }}</template>
                    </template>
                  </span>
                  <span class="notification-item__meta">{{ itemTime(item) }}</span>
                </span>
              </button>
            </li>
          </ul>
          <div v-if="notifications.nextCursor" class="notification-panel__more">
            <el-button link :loading="notifications.loadingMore" @click="notifications.loadMore()">加载更早的通知</el-button>
          </div>
          <p v-else-if="notifications.items.length && notifications.tab === 'all'" class="notification-panel__footnote">只保留最近 90 天的通知</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.notification-bell {
  position: relative;
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  border: 0;
  border-radius: 9px;
  color: #464744;
  background: transparent;
  cursor: pointer;
}

.notification-bell--small { width: 36px; height: 36px; font-size: var(--dsh-font-size-section); }
.notification-bell--large { width: 44px; height: 44px; font-size: var(--dsh-font-size-header); }
.notification-bell:hover,
.notification-bell--open { color: #171817; background: #e7e7e4; }

.notification-bell__badge {
  position: absolute;
  top: 2px;
  right: 0;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  color: #fff;
  background: var(--el-color-danger);
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
  line-height: 16px;
  text-align: center;
}

.notification-layer { position: fixed; z-index: 2000; inset: 0; }
.notification-layer__scrim { position: absolute; inset: 0; border: 0; background: rgb(23 24 23 / 12%); cursor: default; }

.notification-panel {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--notification-panel-left);
  display: flex;
  width: 400px;
  max-width: calc(100vw - var(--notification-panel-left));
  flex-direction: column;
  border-right: 1px solid var(--dsh-color-border);
  background: #fff;
  box-shadow: 8px 0 24px rgb(16 24 40 / 8%);
  outline: none;
}

.notification-panel__header { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px 20px; }
.notification-panel__header h2 { margin: 0; color: #171817; font-size: var(--dsh-font-size-section); font-weight: 650; }
.notification-panel__actions { display: flex; align-items: center; gap: 4px; }

.notification-panel__tabs { display: flex; gap: 20px; padding: 0 20px; border-bottom: 1px solid var(--dsh-color-border); }
.notification-panel__tabs button {
  padding: 8px 0;
  border: 0;
  border-bottom: 2px solid transparent;
  color: #6b6c68;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-body);
}
.notification-panel__tabs button.is-active { border-bottom-color: #171817; color: #171817; font-weight: 600; }

.notification-panel__body { min-height: 0; flex: 1; overflow-y: auto; padding: 6px 8px 16px; }
.notification-panel__state { display: grid; gap: 10px; justify-items: center; padding: 72px 20px; color: #6b6c68; text-align: center; }
.notification-panel__state p { margin: 0; }
.notification-panel__more { display: flex; justify-content: center; padding-top: 8px; }
.notification-panel__footnote { margin: 14px 0 0; color: #6b6c68; font-size: var(--dsh-font-size-caption); text-align: center; }

.notification-list { margin: 0; padding: 0; list-style: none; }
.notification-item {
  display: flex;
  width: 100%;
  gap: 10px;
  margin-top: 2px;
  padding: 12px 12px 12px 4px;
  border: 0;
  border-radius: 10px;
  color: #20211f;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.notification-item:hover { background: #f4f4f2; }
.notification-item--unread { background: #f3f6fd; }
.notification-item--unread:hover { background: #e9effc; }
.notification-item__dot { width: 8px; flex: 0 0 auto; margin-top: 14px; }
.notification-item--unread .notification-item__dot::before { display: block; width: 7px; height: 7px; border-radius: 50%; background: var(--dsh-color-brand); content: ''; }
.notification-item__glyph {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  font-size: var(--dsh-font-size-title);
  font-weight: 700;
}
.notification-item__glyph--mention { color: #2447aa; background: #edf2ff; }
.notification-item__glyph--task_assigned,
.notification-item__glyph--task_completed { color: #16825d; background: #eaf8f2; }
.notification-item__glyph--workspace_member_added { color: #344054; background: #eef0f3; }
.notification-item__glyph--task_schedule_stopped,
.notification-item__glyph--automation_failed { color: var(--dsh-color-warning); background: var(--dsh-color-warning-soft); }
.notification-item__glyph--skill_review_result { color: #5b3fc4; background: #f1edff; }
.notification-item__glyph--dingtalk_bound_by_admin,
.notification-item__glyph--dingtalk_binding_revoked,
.notification-item__glyph--dingtalk_bind_reminder { color: #1d4ed8; background: #eff6ff; }
.notification-item__glyph--hidden { color: #6b6c68; background: #f2f2f0; }
.notification-item__copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 4px; }
.notification-item__text { font-size: var(--dsh-font-size-body); line-height: 1.5; overflow-wrap: anywhere; }
.notification-item--hidden .notification-item__text { color: #6b6c68; }
.notification-item__meta { color: #6b6c68; font-size: var(--dsh-font-size-caption); }

@media (max-width: 820px) {
  .notification-panel { left: 0; width: 100vw; max-width: none; border-right: 0; box-shadow: none; }
}
</style>
