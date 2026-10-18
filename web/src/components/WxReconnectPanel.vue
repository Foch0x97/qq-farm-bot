<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import WxReconnectFields from '@/components/WxReconnectFields.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
const props = defineProps<{ accountId: string }>()
const emit = defineEmits<{ status: [value: any] }>()
const state = ref<any>(null)
const busy = ref(false)
const editing = ref(false)
const error = ref('')
const form = ref({ enabled: true, reconnectDelayMin: 3, reconnectMaxAttempts: 3 })
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
let sequence = 0
const text = computed(() => {
  if (!state.value) return '正在读取重连状态…'
  if (state.value.phase === 'storage_error') return '授权数据读取失败，请检查数据备份'
  if (!state.value.available) return '重新微信扫码后可开启自动重连'
  if (state.value.phase === 'restricted') return '账号登录受限，已关闭自动重连'
  if (state.value.needsScan) return state.value.provider === 'thirdparty' ? '应用宝授权不可用，请检查接口授权' : '微信授权已失效，请重新扫码'
  const labels: Record<string, string> = {
    waiting: '掉线后等待自动重连', refreshing: '正在刷新授权', connecting: '正在重新登录',
    online: '在线', stopped: state.value.enabled ? '自动重连已开启' : '定时重连已关闭', failed: '已达次数上限，可立即重连',
  }
  return labels[state.value.phase] || '自动重连已开启'
})
function apply(value: any) {
  state.value = value
  emit('status', value)
}
async function load() {
  const requestSequence = ++sequence
  try {
    const response = await api.get(`/api/accounts/${props.accountId}/wx-reconnect`, { skipErrorToast: true } as any)
    if (!disposed && requestSequence === sequence) apply(response.data.data)
  }
  catch { /* Keep the last known status on a temporary panel connection failure. */ }
  finally { if (!disposed) timer = setTimeout(load, 10000) }
}
function edit() {
  form.value = { enabled: state.value.enabled, reconnectDelayMin: state.value.reconnectDelayMin, reconnectMaxAttempts: state.value.reconnectMaxAttempts }
  editing.value = !editing.value
}
async function action(kind: 'save' | 'retry' | 'refresh') {
  busy.value = true
  error.value = ''
  ++sequence // Discard any older poll response.
  try {
    const suffix = kind === 'refresh' ? 'wx-authorization/refresh' : kind === 'retry' ? 'wx-reconnect/retry' : 'wx-reconnect'
    const response = await api.post(`/api/accounts/${props.accountId}/${suffix}`, kind === 'save' ? form.value : {})
    if (disposed) return
    apply(response.data.data)
    if (kind === 'save') editing.value = false
  }
  catch (e) { error.value = getApiErrorMessage(e, '操作失败，请稍后重试') }
  finally { busy.value = false }
}
onMounted(load)
onUnmounted(() => { disposed = true; if (timer) clearTimeout(timer) })
</script>
<template>
  <div class="mt-3 space-y-2 border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-700">
    <p>{{ text }}</p>
    <template v-if="state?.available">
      <p>{{ state.provider === 'thirdparty' ? '第三方应用宝' : '本机微信授权' }} · {{ state.reconnectDelayMin }} 分钟 · {{ state.transient ? '请求超时，不计上限' : `已重连 ${state.attempts}/${state.reconnectMaxAttempts} 次` }}</p>
      <p v-if="state.nextAt">下次检查：{{ new Date(state.nextAt).toLocaleTimeString() }}</p>
      <div class="flex flex-wrap gap-2">
        <BaseButton size="sm" variant="text" :disabled="busy" @click="edit">重连设置</BaseButton>
        <BaseButton size="sm" variant="text" :disabled="busy || !state.enabled || state.phase === 'online' || state.phase === 'refreshing' || state.phase === 'connecting'" @click="action('retry')">立即重连</BaseButton>
        <BaseButton size="sm" variant="text" :disabled="busy || state.pending" @click="action('refresh')">刷新授权</BaseButton>
      </div>
      <div v-if="editing" class="space-y-2">
        <WxReconnectFields v-model="form" />
        <BaseButton size="sm" :loading="busy" @click="action('save')">保存重连设置</BaseButton>
      </div>
    </template>
    <p v-if="error" class="text-red-500">{{ error }}</p>
  </div>
</template>
