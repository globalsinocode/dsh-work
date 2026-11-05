<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { adminApi, AdminApiError } from '@/api/client'
import type { DingTalkBindPreview, DingTalkBindingView } from '@/types/domain'
import { dingtalkBoundBy, dingtalkRevokeReason, dingtalkStatusLabel, dingtalkStatusTag } from '@/utils/dingtalk'

/**
 * 员工详情 › 钉钉（钉钉接入 DT-S1，原型①）：查看绑定、管理员代绑（手机号 → 预览姓名部门 → 只提交确认凭证）、
 * 冲突改绑、解绑（可锁定自行绑定）与解除锁定。
 */
const props = defineProps<{ userId: string; userName: string; canManage: boolean }>()
const emit = defineEmits<{ changed: [] }>()

type Step = 'idle' | 'input' | 'preview'
const view = ref<DingTalkBindingView>()
const loading = ref(false)
const busy = ref(false)
const step = ref<Step>('idle')
const mobile = ref('')
const preview = ref<DingTalkBindPreview>()
const identityConfirmed = ref(false)
const error = ref('')
const flash = ref('')
const unbindDialogOpen = ref(false)
const lockSelfRebind = ref(false)

const boundBy = computed(() => view.value?.binding ? dingtalkBoundBy(view.value.binding.boundBy, view.value.binding.boundByAdminName) : '')
const dingtalkLabel = computed(() => {
  const binding = view.value?.binding
  if (!binding) return ''
  return binding.dingtalkDepartment ? `${binding.dingtalkName ?? '未知姓名'}（${binding.dingtalkDepartment}）` : binding.dingtalkName ?? '未知姓名'
})
const canConfirm = computed(() => Boolean(preview.value) && (!preview.value!.requireIdentityConfirmation || identityConfirmed.value))

async function load() {
  loading.value = true
  error.value = ''
  try {
    view.value = await adminApi.getDingTalkBinding(props.userId)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '钉钉绑定加载失败'
  } finally {
    loading.value = false
  }
}

function startBind() {
  step.value = 'input'
  preview.value = undefined
  identityConfirmed.value = false
  error.value = ''
  flash.value = ''
}

function cancel() {
  step.value = 'idle'
  preview.value = undefined
  error.value = ''
}

async function lookup() {
  if (!mobile.value.trim()) {
    error.value = '请输入员工在钉钉中使用的手机号'
    return
  }
  busy.value = true
  error.value = ''
  try {
    preview.value = await adminApi.previewDingTalkBinding(props.userId, mobile.value.trim())
    identityConfirmed.value = false
    step.value = 'preview'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '查找失败'
  } finally {
    busy.value = false
  }
}

async function confirm() {
  if (!preview.value) return
  busy.value = true
  error.value = ''
  try {
    view.value = await adminApi.confirmDingTalkBinding(props.userId, {
      confirmationToken: preview.value.confirmationToken,
      identityConfirmed: identityConfirmed.value,
      rebind: Boolean(preview.value.conflict),
    })
    flash.value = `已绑定。已通知${props.userName}，并写入审计记录。`
    step.value = 'idle'
    preview.value = undefined
    mobile.value = ''
    emit('changed')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '绑定失败'
    // 凭证失效或绑定状态变化：回到输入，重新查找。
    if (cause instanceof AdminApiError && ['dingtalk_confirmation_invalid', 'dingtalk_conflict_changed'].includes(cause.code)) step.value = 'input'
  } finally {
    busy.value = false
  }
}

function askUnbind() {
  lockSelfRebind.value = false
  unbindDialogOpen.value = true
}

async function unbind() {
  const lock = lockSelfRebind.value
  busy.value = true
  error.value = ''
  try {
    view.value = await adminApi.unbindDingTalk(props.userId, lock)
    unbindDialogOpen.value = false
    flash.value = lock ? '已解除绑定并锁定自行绑定，该员工在钉钉内的登录已失效。' : '已解除绑定，该员工在钉钉内的登录已失效。'
    emit('changed')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '解除绑定失败'
  } finally {
    busy.value = false
  }
}

async function unlock() {
  busy.value = true
  error.value = ''
  try {
    view.value = await adminApi.unlockDingTalkSelfBinding(props.userId)
    flash.value = '已解除锁定，员工可在钉钉内登录重新绑定。'
    emit('changed')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '解除锁定失败'
  } finally {
    busy.value = false
  }
}

watch(() => props.userId, () => {
  step.value = 'idle'
  preview.value = undefined
  flash.value = ''
  mobile.value = ''
  void load()
}, { immediate: true })
</script>

<template>
  <section class="drawer-section dingtalk-panel" aria-label="钉钉">
    <div class="drawer-section__heading"><div><strong>钉钉</strong><span>可接收钉钉通知、在钉钉内免登</span></div></div>
    <div v-loading="loading" class="dingtalk-panel__card">
      <template v-if="view?.status === 'bound' && view.binding">
        <div class="dingtalk-panel__state">
          <el-tag type="success" effect="plain">已绑定</el-tag>
          <span>可接收钉钉通知，可在钉钉内免登</span>
        </div>
        <dl class="dingtalk-panel__facts">
          <dt>钉钉成员</dt><dd>{{ dingtalkLabel }}</dd>
          <dt>绑定方式</dt><dd>{{ boundBy }}</dd>
          <dt>绑定时间</dt><dd>{{ new Date(view.binding.boundAt).toLocaleString('zh-CN', { hour12: false }) }}</dd>
        </dl>
        <template v-if="canManage">
          <el-button :loading="busy" @click="askUnbind">解除绑定</el-button>
          <p class="dingtalk-panel__hint">解除后停止推送，并让该员工在钉钉内的登录失效；员工下次在钉钉内登录会重新绑定（锁定时除外）。</p>
        </template>
      </template>

      <template v-else-if="view">
        <div class="dingtalk-panel__state">
          <el-tag :type="dingtalkStatusTag[view.status]" effect="plain">{{ dingtalkStatusLabel[view.status] }}</el-tag>
          <span>{{ view.status === 'invalid' ? dingtalkRevokeReason(view.invalid?.reason) : '收不到钉钉通知' }}</span>
          <el-tag v-if="view.selfRebindLocked" type="warning" effect="plain">已锁定自行绑定</el-tag>
        </div>
        <p class="dingtalk-panel__intro">
          员工在钉钉工作台打开 dsh-work 并用账号密码登录一次即可自动绑定。也可以由你代为绑定，绑定后员工无需操作即可收到通知并在钉钉内免登。
        </p>

        <div v-if="canManage && step === 'idle'" class="dingtalk-panel__actions">
          <el-button type="primary" @click="startBind">代为绑定钉钉</el-button>
          <el-button v-if="view.selfRebindLocked" :loading="busy" @click="unlock">解除锁定</el-button>
        </div>

        <form v-if="canManage && step === 'input'" class="dingtalk-panel__lookup" @submit.prevent="lookup">
          <label for="dingtalk-bind-mobile">员工在钉钉中使用的手机号</label>
          <div class="dingtalk-panel__row">
            <el-input id="dingtalk-bind-mobile" v-model="mobile" inputmode="tel" autocomplete="off" placeholder="例如 138 0000 2201" :maxlength="20" :disabled="busy" />
            <el-button type="primary" native-type="submit" :loading="busy">在钉钉中查找</el-button>
            <el-button :disabled="busy" @click="cancel">取消</el-button>
          </div>
          <p class="dingtalk-panel__hint">手机号只用于本次查找，审计只记录后 4 位，平台不保存。</p>
        </form>

        <div v-if="canManage && step === 'preview' && preview" class="dingtalk-panel__preview" :class="{ 'dingtalk-panel__preview--conflict': preview.conflict }">
          <template v-if="preview.conflict">
            <p><strong>钉钉成员“{{ preview.dingtalkName ?? '未知姓名' }}{{ preview.dingtalkDepartment ? `（${preview.dingtalkDepartment}）` : '' }}”已绑定平台员工“{{ preview.conflict.name }}”。</strong></p>
            <p>改绑后，原员工的钉钉绑定失效、钉钉内登录被撤销，并收到站内通知。</p>
          </template>
          <p v-else>将绑定以下钉钉成员，请确认是本人：</p>
          <div class="dingtalk-panel__member">
            <span class="dingtalk-panel__avatar" aria-hidden="true">{{ [...(preview.dingtalkName ?? '钉')][0] }}</span>
            <div>
              <strong>{{ preview.dingtalkName ?? '未知姓名' }}</strong>
              <div class="dingtalk-panel__muted">{{ preview.dingtalkDepartment ?? '部门读取失败' }} · {{ preview.maskedMobile }}</div>
            </div>
          </div>
          <el-alert
            v-if="!preview.nameMatches"
            type="warning"
            :closable="false"
            show-icon
            :title="`钉钉姓名“${preview.dingtalkName ?? '未知'}”与员工姓名“${preview.platformName}”不一致，请核实是否为本人。`"
          />
          <el-alert
            v-else-if="preview.dingtalkDepartment === null"
            type="warning"
            :closable="false"
            show-icon
            title="未能读取钉钉部门，请通过其他方式核实是本人。"
          />
          <el-checkbox v-if="preview.requireIdentityConfirmation" v-model="identityConfirmed">我已核实是本人</el-checkbox>
          <p class="dingtalk-panel__warning">绑定后，这个钉钉账号可在钉钉内免登进入“{{ userName }}”的平台账号。</p>
          <div class="dingtalk-panel__row">
            <el-button type="primary" :loading="busy" :disabled="!canConfirm" @click="confirm">{{ preview.conflict ? `改绑到 ${userName}` : '确认绑定' }}</el-button>
            <el-button :disabled="busy" @click="startBind">{{ preview.conflict ? '重新输入' : '不是此人，重新输入' }}</el-button>
          </div>
        </div>
      </template>

      <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" role="alert" />
      <p v-if="flash" role="status" class="dingtalk-panel__flash">{{ flash }}</p>
    </div>
    <el-dialog v-model="unbindDialogOpen" :title="`解除${userName}的钉钉绑定？`" width="min(460px, calc(100vw - 32px))" append-to-body>
      <p class="dingtalk-panel__intro">解除后停止推送，并让该员工在钉钉内的登录立即失效。员工下次在钉钉内登录会重新绑定。</p>
      <el-checkbox v-model="lockSelfRebind">锁定自行绑定（怀疑账号被盗用或绑错人时使用；解除锁定或重新代绑后恢复）</el-checkbox>
      <template #footer>
        <el-button :disabled="busy" @click="unbindDialogOpen = false">取消</el-button>
        <el-button type="danger" :loading="busy" @click="unbind">解除绑定</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.dingtalk-panel__card { display: grid; gap: 12px; padding: 14px 16px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; }
.dingtalk-panel__state { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; color: var(--el-text-color-secondary); }
.dingtalk-panel__facts { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px 12px; margin: 0; font-size: 13px; }
.dingtalk-panel__facts dt { color: var(--el-text-color-secondary); }
.dingtalk-panel__facts dd { margin: 0; }
.dingtalk-panel__intro { margin: 0; font-size: 13px; line-height: 1.7; }
.dingtalk-panel__actions, .dingtalk-panel__row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dingtalk-panel__row .el-input { max-width: 240px; }
.dingtalk-panel__lookup { display: grid; gap: 6px; }
.dingtalk-panel__lookup label { font-size: 13px; }
.dingtalk-panel__hint, .dingtalk-panel__muted { margin: 0; font-size: 12px; color: var(--el-text-color-secondary); }
.dingtalk-panel__preview { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--el-color-primary-light-7); border-radius: 8px; background: var(--el-color-primary-light-9); font-size: 13px; }
.dingtalk-panel__preview p { margin: 0; }
.dingtalk-panel__preview--conflict { border-color: var(--el-color-warning-light-5); background: var(--el-color-warning-light-9); }
.dingtalk-panel__member { display: flex; align-items: center; gap: 12px; }
.dingtalk-panel__avatar { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%; background: var(--el-color-primary-light-8); color: var(--el-color-primary); font-weight: 600; }
.dingtalk-panel__warning { color: var(--el-color-warning-dark-2); font-size: 12px; }
.dingtalk-panel__flash { margin: 0; color: var(--el-color-success); font-size: 13px; }
</style>
