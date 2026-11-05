<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { adminApi } from '@/api/client'
import type { DingTalkIntegrationOverview, DingTalkUnboundEmployee } from '@/types/domain'
import { dingtalkRevokeReason } from '@/utils/dingtalk'

/**
 * 钉钉集成（钉钉接入 DT-S1，原型②）：应用配置与连接检查、绑定情况、离职检查、未绑定名单与提醒。
 * 通知投递记录在 DT-S2 启用。凭据只在服务端环境变量中，此处不可查看。
 */
type Tab = 'overview' | 'unbound' | 'delivery'
const route = useRoute()
const router = useRouter()
const tab = ref<Tab>(route.query.tab === 'unbound' ? 'unbound' : route.query.tab === 'delivery' ? 'delivery' : 'overview')
const overview = ref<DingTalkIntegrationOverview>()
const unbound = ref<DingTalkUnboundEmployee[]>([])
const unboundTotal = ref(0)
const loading = ref(false)
const checking = ref(false)
const reminding = ref(false)
const deciding = ref(false)
const error = ref('')
const checkMessage = ref('')
const listMessage = ref('')

const counts = computed(() => overview.value?.counts)
const boundRatio = computed(() => {
  const value = counts.value
  return value && value.activeLocal ? Math.round((value.bound / value.activeLocal) * 100) : 0
})
const capabilityRows = computed(() => {
  const capabilities = overview.value?.connection?.capabilities ?? {}
  return [
    { key: 'credentials', label: '应用凭据', note: '' },
    { key: 'login', label: '钉钉内免登', note: '企业内部应用默认具备，以真机登录验证' },
    { key: 'mobileLookup', label: '按手机号查找成员', note: '管理员代绑用' },
    { key: 'memberRead', label: '读取成员基本信息', note: '代绑确认与离职检查用' },
    { key: 'departmentRead', label: '读取部门信息', note: '代绑时显示部门' },
  ].map(row => ({ ...row, state: row.key === 'login' ? 'default' : capabilities[row.key] ?? 'unchecked' }))
})
const connectionTag = computed(() => {
  const status = overview.value?.connection?.status
  if (!overview.value?.configured) return { type: 'info' as const, label: '未配置' }
  if (status === 'ok') return { type: 'success' as const, label: '连接正常' }
  if (status === 'configuration_error') return { type: 'danger' as const, label: '配置异常' }
  if (status === 'unavailable') return { type: 'warning' as const, label: '暂时不可用' }
  return { type: 'info' as const, label: '尚未检查' }
})

async function loadOverview() {
  overview.value = await adminApi.getDingTalkOverview()
}

async function loadUnbound() {
  const page = await adminApi.getDingTalkUnbound()
  unbound.value = page.items
  unboundTotal.value = page.total
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    await Promise.all([loadOverview(), loadUnbound()])
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '钉钉集成信息加载失败'
  } finally {
    loading.value = false
  }
}

async function check() {
  checking.value = true
  checkMessage.value = ''
  try {
    overview.value = await adminApi.checkDingTalkConnection()
    checkMessage.value = overview.value.connection?.status === 'ok'
      ? '连接正常：凭据有效，各项接口权限均已开通。'
      : overview.value.connection?.message ?? '检查未通过'
  } catch (cause) {
    checkMessage.value = cause instanceof Error ? cause.message : '连接检查失败'
  } finally {
    checking.value = false
  }
}

async function remind(target: DingTalkUnboundEmployee | null) {
  reminding.value = true
  listMessage.value = ''
  try {
    const result = await adminApi.remindDingTalkBinding(target ? { userIds: [target.id] } : { all: true })
    listMessage.value = target
      ? (result.reminded ? `已提醒${target.name}。` : `${target.name}已被锁定自行绑定，未提醒。`)
      : `已提醒 ${result.reminded} 名未绑定员工。`
  } catch (cause) {
    listMessage.value = cause instanceof Error ? cause.message : '提醒失败'
  } finally {
    reminding.value = false
  }
}

async function decide(decision: 'confirm' | 'dismiss') {
  const paused = overview.value?.departureCheck.pausedRun
  if (!paused) return
  deciding.value = true
  try {
    const result = await adminApi.decideDingTalkDepartureCheck(paused.id, decision)
    checkMessage.value = decision === 'confirm' ? `已使 ${result.invalidated} 个离职员工的钉钉绑定失效。` : '已忽略本次离职检查结果，绑定不变。'
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败'
  } finally {
    deciding.value = false
  }
}

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

const departureStatus: Record<string, string> = {
  completed: '已完成', paused: '已暂停，待确认', confirmed: '已确认执行', dismissed: '已忽略',
  configuration_error: '配置异常', failed: '检查失败',
}

watch(tab, value => { void router.replace({ query: value === 'overview' ? {} : { tab: value } }) })
onMounted(load)
</script>

<template>
  <div class="ops-page dingtalk-page">
    <el-alert type="info" :closable="false" show-icon title="钉钉只用于发送工作通知和在钉钉内打开员工端；钉钉中的部门、群和角色不授予平台任何权限。" />
    <el-alert v-if="error" :title="error" type="error" show-icon @close="error = ''" />

    <el-tabs v-model="tab" v-loading="loading">
      <el-tab-pane label="概况" name="overview">
        <div v-if="overview" class="dingtalk-grid">
          <section class="content-panel dingtalk-card" aria-label="应用配置">
            <div class="dingtalk-card__heading">
              <h2>应用配置</h2>
              <el-tag :type="connectionTag.type" effect="plain">{{ connectionTag.label }}</el-tag>
            </div>
            <dl class="dingtalk-kv">
              <dt>企业内部应用</dt>
              <dd>{{ overview.configured ? `AgentId ${overview.agentId}` : '未配置' }}</dd>
              <dt>应用凭据</dt>
              <dd>{{ overview.configured ? '已在服务端配置' : '未配置' }} <small>（由部署人员在环境变量中设置，此处不可查看）</small></dd>
              <dt>钉钉内入口</dt>
              <dd>
                <template v-if="overview.publicEntries.length">{{ overview.publicEntries.join('、') }}</template>
                <template v-else>未登记公网员工端入口 <small>（部署手册“公网入口”）</small></template>
              </dd>
              <dt>最近检查</dt>
              <dd>{{ formatDate(overview.connection?.checkedAt) }}</dd>
            </dl>
            <h3>接口权限</h3>
            <dl class="dingtalk-kv">
              <template v-for="row in capabilityRows" :key="row.key">
                <dt>{{ row.label }}</dt>
                <dd>
                  <el-tag v-if="row.state === 'ok'" type="success" effect="plain">已开通</el-tag>
                  <el-tag v-else-if="row.state === 'denied'" type="danger" effect="plain">未开通</el-tag>
                  <el-tag v-else-if="row.state === 'unknown'" type="warning" effect="plain">无法检查</el-tag>
                  <el-tag v-else-if="row.state === 'default'" type="info" effect="plain">默认具备</el-tag>
                  <el-tag v-else type="info" effect="plain">未检查</el-tag>
                  <small v-if="row.note">{{ row.note }}</small>
                </dd>
              </template>
            </dl>
            <div><el-button :loading="checking" :disabled="!overview.configured" @click="check">重新检查连接</el-button></div>
            <p v-if="checkMessage" role="status" class="dingtalk-status">{{ checkMessage }}</p>
          </section>

          <section class="content-panel dingtalk-card" aria-label="绑定情况">
            <h2>绑定情况</h2>
            <div class="dingtalk-stats">
              <div><strong class="dingtalk-stat dingtalk-stat--ok">{{ counts?.bound }}</strong><span>已绑定</span></div>
              <div><strong class="dingtalk-stat">{{ counts?.unbound }}</strong><span>未绑定</span></div>
              <div><strong class="dingtalk-stat dingtalk-stat--bad">{{ counts?.invalid }}</strong><span>已失效</span></div>
            </div>
            <el-progress :percentage="boundRatio" :show-text="false" status="success" :aria-label="`已绑定 ${boundRatio}%`" />
            <ul class="dingtalk-notes">
              <li>已绑定中，员工本人在钉钉内登录 {{ counts?.selfBound }} 人，管理员代绑 {{ counts?.adminBound }} 人。</li>
              <li>
                每天 03:00 后检查已绑定的钉钉账号是否仍是企业成员，离职的自动失效。上次检查：
                {{ overview.departureCheck.lastRun ? `${formatDate(overview.departureCheck.lastRun.startedAt)}，${departureStatus[overview.departureCheck.lastRun.status] ?? overview.departureCheck.lastRun.status}` : '尚未检查' }}。
              </li>
            </ul>
            <el-alert
              v-if="overview.departureCheck.persistentWarning"
              type="error"
              :closable="false"
              show-icon
              title="离职检查异常：连续 3 次检查失败比例超过 5%，离职员工可能未被及时失效。请检查钉钉应用权限与通讯录范围。"
            />
            <div v-if="overview.departureCheck.pausedRun" class="dingtalk-paused" role="alert">
              <p>
                本次离职检查判定 <strong>{{ overview.departureCheck.pausedRun.pending }}</strong> 人已离职，超过已绑定人数
                {{ overview.departureCheck.pausedRun.bound }} 的 10%，已整批暂停。请核实后再执行。
              </p>
              <div class="dingtalk-actions">
                <el-button type="danger" :loading="deciding" @click="decide('confirm')">确认失效这些绑定</el-button>
                <el-button :disabled="deciding" @click="decide('dismiss')">忽略本次结果</el-button>
              </div>
            </div>
            <div><el-button type="primary" @click="tab = 'unbound'">查看未绑定名单</el-button></div>
          </section>
        </div>
      </el-tab-pane>

      <el-tab-pane :label="`未绑定（${unboundTotal}）`" name="unbound">
        <section class="content-panel content-panel--flush">
          <div class="dingtalk-list-head">
            <span>这些员工收不到钉钉通知。可以代为绑定，或提醒他们在钉钉中打开 dsh-work 登录一次。</span>
            <el-button :loading="reminding" :disabled="!unboundTotal" @click="remind(null)">提醒全部未绑定员工</el-button>
          </div>
          <el-table class="data-table" :data="unbound" empty-text="所有有效员工都已绑定钉钉">
            <el-table-column label="员工" min-width="200">
              <template #default="scope"><strong>{{ scope.row.name }}</strong><div class="dingtalk-muted">{{ scope.row.loginAccount }}</div></template>
            </el-table-column>
            <el-table-column prop="department" label="部门" min-width="140" />
            <el-table-column label="状态" min-width="200">
              <template #default="scope">
                <el-tag :type="scope.row.status === 'invalid' ? 'danger' : 'info'" effect="plain">{{ scope.row.status === 'invalid' ? '已失效' : '未绑定' }}</el-tag>
                <div v-if="scope.row.status === 'invalid' || scope.row.selfRebindLocked" class="dingtalk-muted">
                  {{ scope.row.status === 'invalid' ? dingtalkRevokeReason(scope.row.revokeReason) : '' }}{{ scope.row.selfRebindLocked ? '（已锁定自行绑定）' : '' }}
                </div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="200">
              <template #default="scope">
                <el-button link type="primary" @click="router.push({ path: '/identity', query: { user: scope.row.id, query: scope.row.loginAccount } })">代为绑定</el-button>
                <el-button link type="primary" :disabled="reminding || scope.row.selfRebindLocked" @click="remind(scope.row)">提醒员工</el-button>
              </template>
            </el-table-column>
          </el-table>
          <p v-if="listMessage" role="status" class="dingtalk-status dingtalk-list-foot">{{ listMessage }}</p>
          <p class="dingtalk-muted dingtalk-list-foot">“提醒员工”发送一条站内通知：在钉钉工作台打开 dsh-work，用账号密码登录一次即可绑定。</p>
        </section>
      </el-tab-pane>

      <el-tab-pane label="通知投递" name="delivery">
        <section class="content-panel dingtalk-empty">
          <h2>通知投递记录</h2>
          <p>钉钉工作通知在下一阶段（DT-S2）启用。启用后这里列出发送失败、被钉钉限流或因权限复核被跳过的通知。</p>
        </section>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.dingtalk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 16px; }
.dingtalk-card { display: grid; gap: 14px; align-content: start; }
.dingtalk-card h2 { margin: 0; font-size: 16px; }
.dingtalk-card h3 { margin: 4px 0 0; font-size: 14px; }
.dingtalk-card__heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.dingtalk-kv { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px 12px; margin: 0; font-size: 14px; align-items: center; }
.dingtalk-kv dt { color: var(--el-text-color-secondary); }
.dingtalk-kv dd { margin: 0; overflow-wrap: anywhere; }
.dingtalk-kv small, .dingtalk-muted { color: var(--el-text-color-secondary); font-size: 12px; }
.dingtalk-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.dingtalk-stats span { display: block; font-size: 13px; color: var(--el-text-color-secondary); }
.dingtalk-stat { font-size: 26px; font-variant-numeric: tabular-nums; }
.dingtalk-stat--ok { color: var(--el-color-success); }
.dingtalk-stat--bad { color: var(--el-color-danger); }
.dingtalk-notes { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.8; }
.dingtalk-paused { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--el-color-warning-light-5); border-radius: 8px; background: var(--el-color-warning-light-9); font-size: 13px; }
.dingtalk-paused p { margin: 0; }
.dingtalk-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dingtalk-status { margin: 0; font-size: 13px; color: var(--el-color-success); }
.dingtalk-list-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; padding: 12px 16px; font-size: 13px; }
.dingtalk-list-foot { padding: 0 16px 12px; }
.dingtalk-empty { text-align: center; padding: 48px 20px; }
.dingtalk-empty h2 { margin: 0; font-size: 16px; }
.dingtalk-empty p { max-width: 520px; margin: 8px auto 0; color: var(--el-text-color-secondary); line-height: 1.7; }
@media (max-width: 640px) {
  .dingtalk-kv { grid-template-columns: minmax(0, 1fr); }
}
</style>
