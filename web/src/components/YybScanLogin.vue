<script setup lang="ts">
import { NInputNumber } from 'naive-ui/es/input-number'
import { NRadio, NRadioGroup } from 'naive-ui/es/radio'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useAccountStore } from '@/stores/account'

const props = defineProps<{ accountId?: string }>()
const remark = defineModel<string>('remark', { required: true })
const emit = defineEmits<{ close: [] }>()
const accountStore = useAccountStore()
const authorizationSaved = ref(false)
const accountId = ref(props.accountId || '')
const channels = [{ id: 'yyb', name: '应用宝', description: '应用宝微信授权' }, { id: 'pcmgr', name: 'PCMgr', description: '腾讯电脑管家微信授权' }] as const
const channel = ref<'yyb' | 'pcmgr'>('yyb')
const channelDescription = computed(() => channels.find(item => item.id === channel.value)?.description)
const config = reactive({ enabled: true, reconnectDelayMin: 3, reconnectMaxAttempts: 3 })
const state = ref<any>(null)
const qr = ref('')
const status = ref('正在获取二维码…')
const error = ref('')
const scanning = ref(false)
const saving = ref(false)
const retrying = ref(false)
let taskId = ''
let generation = 0
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
let stateTimer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
const connection = computed(() => {
  if (!state.value?.available) return '连接：-'
  const labels: Record<string, string> = { online: '在线', waiting: '等待重连', refreshing: '正在换 Code', connecting: '连接中', stopped: '已停止', failed: '重连已停止', restricted: '登录受限' }
  return `连接：${labels[state.value.phase] || '-'}${state.value.attempts ? ` · 已重连${state.value.attempts}次` : ''}`
})
async function loadConfig(initial = false) {
  const requestedAccount = accountId.value
  const response = await api.get('/api/yyb-scan/config', { params: { accountId: requestedAccount }, skipErrorToast: true } as any)
  if (disposed || requestedAccount !== accountId.value) return
  state.value = response.data.data
  if (initial) {
    Object.assign(config, { enabled: state.value.enabled, reconnectDelayMin: state.value.reconnectDelayMin, reconnectMaxAttempts: state.value.reconnectMaxAttempts })
    if (channels.some(item => item.id === state.value.authorizationChannel)) channel.value = state.value.authorizationChannel
  }
}
async function pollState() {
  try { await loadConfig() } catch {}
  if (!disposed) stateTimer = setTimeout(pollState, 10000)
}
async function save() {
  if (saving.value) return
  saving.value = true; error.value = ''
  try {
    const response = await api.post('/api/yyb-scan/config', { ...config, accountId: accountId.value }, { skipErrorToast: true } as any)
    if (!response.data.ok) throw new Error(getApiErrorMessage(response.data))
    status.value = '设置已保存'
    await loadConfig()
  }
  catch (e) { error.value = getApiErrorMessage(e, '保存失败') }
  finally { saving.value = false }
}
async function retry() {
  if (retrying.value) return
  error.value = ''
  if (!state.value?.available) { error.value = '请先通过微信登录扫码授权'; return }
  retrying.value = true
  try {
    const response = await api.post('/api/yyb-scan/retry', { accountId: accountId.value }, { skipErrorToast: true } as any)
    if (!response.data.ok) throw new Error(getApiErrorMessage(response.data))
    await loadConfig()
  }
  catch (e) { error.value = getApiErrorMessage(e, '触发重连失败') }
  finally { retrying.value = false }
}
function cancel() {
  ++generation
  if (timer) clearTimeout(timer)
  controller?.abort()
  controller = undefined
  const oldTask = taskId; taskId = ''
  if (oldTask) void api.delete(`/api/yyb-scan/tasks/${oldTask}`, { skipErrorToast: true } as any).catch(() => undefined)
  if (qr.value) URL.revokeObjectURL(qr.value)
  qr.value = ''; scanning.value = false
}
async function poll(version: number) {
  if (version !== generation || disposed || !taskId) return
  controller = new AbortController()
  try {
    const response = await api.get(`/api/yyb-scan/tasks/${taskId}/status`, { signal: controller.signal, timeout: 40000, skipErrorToast: true } as any)
    if (version !== generation || disposed) return
    const scanStatus = response.data.data?.status
    if (scanStatus === 'authorized') {
      status.value = '手机已确认，正在登录…'
      const result = await api.post(`/api/yyb-scan/tasks/${taskId}/complete`, { ...config, remark: remark.value.trim(), ...(props.accountId ? { accountId: props.accountId } : {}) }, { signal: controller.signal, timeout: 120000, skipErrorToast: true } as any)
      if (version !== generation || disposed) return
      if (!result.data.ok) throw new Error(getApiErrorMessage(result.data))
      accountId.value = String(result.data.data.accountId)
      authorizationSaved.value = true
      scanning.value = false
      if (qr.value) URL.revokeObjectURL(qr.value)
      qr.value = ''
      status.value = '微信授权已保存'
      if (result.data.data.startup === 'failed') {
        error.value = '账号未能启动，可从账号列表重新启动。已开启自动重连时，也可在此点击「立即重连」。'
      }
      void accountStore.fetchAccounts().catch(() => undefined)
      void loadConfig().catch(() => undefined)
      return
    }
    if (['expired', 'cancelled', 'failed'].includes(scanStatus)) throw new Error('二维码已失效，请重新获取')
    status.value = scanStatus === 'scanned' ? '已扫描，请在手机上确认…' : '请使用手机微信扫码'
    timer = setTimeout(() => void poll(version), 2500)
  }
  catch (e: any) {
    if (version !== generation || disposed || e?.code === 'ERR_CANCELED') return
    error.value = getApiErrorMessage(e, '扫码登录失败')
    scanning.value = false
  }
}
function changeChannel(value: 'yyb' | 'pcmgr') {
  if (channel.value === value) return
  channel.value = value
  void start()
}
async function start() {
  cancel()
  const version = generation
  scanning.value = true; error.value = ''; status.value = '正在获取二维码…'
  controller = new AbortController()
  try {
    const response = await api.post('/api/yyb-scan/tasks', { channel: channel.value }, { signal: controller.signal, timeout: 40000, skipErrorToast: true } as any)
    const task = response.data.data
    if (version !== generation || disposed) {
      if (task?.taskId) void api.delete(`/api/yyb-scan/tasks/${task.taskId}`, { skipErrorToast: true } as any).catch(() => undefined)
      return
    }
    if (!response.data.ok || !task?.taskId || !task?.qrUrl) throw new Error(getApiErrorMessage(response.data, '获取二维码失败'))
    taskId = task.taskId
    const image = await api.get(task.qrUrl, { responseType: 'blob', signal: controller.signal, skipErrorToast: true } as any)
    if (version !== generation || disposed) return
    qr.value = URL.createObjectURL(image.data)
    status.value = '请使用手机微信扫码'
    void poll(version)
  }
  catch (e: any) {
    if (version !== generation || disposed || e?.code === 'ERR_CANCELED') return
    error.value = getApiErrorMessage(e, '获取二维码失败'); scanning.value = false
  }
}
onMounted(async () => { try { await loadConfig(true) } catch {} if (!disposed) { void start(); void pollState() } })
onBeforeUnmount(() => { disposed = true; cancel(); if (stateTimer) clearTimeout(stateTimer) })
</script>

<template>
  <section class="space-y-4" role="tabpanel" aria-label="微信登录">
    <BaseInput
      v-model="remark"
      label="账号备注（可留空）"
      :placeholder="accountId ? '留空时保留现有备注' : '留空时使用微信昵称'"
      :disabled="authorizationSaved"
      class="farm-input"
    />
    <NRadioGroup
      :value="channel"
      :disabled="authorizationSaved"
      name="wechat-authorization-channel"
      aria-label="微信授权渠道"
      @update:value="changeChannel"
    >
      <div class="flex gap-5">
        <NRadio v-for="item in channels" :key="item.id" :value="item.id">{{ item.name }}</NRadio>
      </div>
    </NRadioGroup>
    <div class="flex flex-col items-center gap-3 py-2 text-center text-sm">
      <div v-if="qr" class="bg-white p-2">
        <img :src="qr" class="h-52 w-52 object-contain" :alt="`${channelDescription}二维码`">
      </div>
      <div v-else-if="scanning" class="h-52 w-52 flex items-center justify-center opacity-60">
        {{ status }}
      </div>
      <p v-if="qr || !scanning" role="status">{{ status }}</p>
    </div>
    <div class="space-y-3">
      <BaseSwitch v-model="config.enabled" label="开启掉线自动重连" />
      <div class="grid grid-cols-2 gap-3">
        <div class="min-w-0 space-y-2">
          <p id="wechat-reconnect-delay-label" class="text-sm">离线多久重连（分钟）</p>
          <NInputNumber
            class="w-full"
            :value="config.reconnectDelayMin"
            :min="1"
            :max="10080"
            :input-props="{ 'aria-labelledby': 'wechat-reconnect-delay-label' }"
            @update:value="value => config.reconnectDelayMin = value ?? 3"
          />
        </div>
        <div class="min-w-0 space-y-2">
          <p id="wechat-reconnect-max-label" class="text-sm">失败几次停止</p>
          <NInputNumber
            class="w-full"
            :value="config.reconnectMaxAttempts"
            :min="1"
            :max="10000"
            :input-props="{ 'aria-labelledby': 'wechat-reconnect-max-label' }"
            @update:value="value => config.reconnectMaxAttempts = value ?? 3"
          />
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-sm opacity-70" role="status">{{ connection }}</span>
        <div class="flex gap-2">
          <BaseButton size="sm" variant="outline" :loading="retrying" :disabled="state?.pending || state?.phase === 'online'" @click="retry">
            立即重连
          </BaseButton>
          <BaseButton size="sm" variant="primary" :loading="saving" @click="save">保存</BaseButton>
        </div>
      </div>
    </div>
    <p v-if="error" class="text-sm text-red-500" role="alert">{{ error }}</p>
    <div class="flex justify-end gap-2 pt-2">
      <BaseButton v-if="!scanning && !authorizationSaved" variant="outline" @click="start">刷新二维码</BaseButton>
      <BaseButton variant="outline" @click="emit('close')">关闭</BaseButton>
    </div>
  </section>
</template>
