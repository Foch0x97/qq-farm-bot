<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'

const props = defineProps<{ accountId?: string }>()
const emit = defineEmits<{ saved: [], close: [] }>()
const accountId = ref(props.accountId || '')
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
  const response = await api.get('/api/yyb-scan/config', { params: { accountId: accountId.value }, skipErrorToast: true } as any)
  if (disposed) return
  state.value = response.data.data
  if (initial) Object.assign(config, { enabled: state.value.enabled, reconnectDelayMin: state.value.reconnectDelayMin, reconnectMaxAttempts: state.value.reconnectMaxAttempts })
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
  if (!state.value?.available) { error.value = '请先通过应用宝登录扫码授权'; return }
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
      const result = await api.post(`/api/yyb-scan/tasks/${taskId}/complete`, { ...config, ...(props.accountId ? { accountId: props.accountId } : {}) }, { signal: controller.signal, timeout: 120000, skipErrorToast: true } as any)
      if (version !== generation || disposed) return
      if (!result.data.ok) throw new Error(getApiErrorMessage(result.data))
      accountId.value = String(result.data.data.accountId)
      scanning.value = false
      emit('saved')
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
async function start() {
  cancel()
  const version = generation
  scanning.value = true; error.value = ''; status.value = '正在获取二维码…'
  controller = new AbortController()
  try {
    const response = await api.post('/api/yyb-scan/tasks', {}, { signal: controller.signal, timeout: 40000, skipErrorToast: true } as any)
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
  <section class="go-yyb-scan" role="tabpanel" aria-label="应用宝登录">
    <div class="handle" />
    <h3>📱 扫码登录</h3>
    <div class="qr-area">
      <img v-if="qr" :src="qr" class="qr-image" alt="应用宝微信授权二维码">
      <p v-else class="muted">{{ scanning ? '获取二维码中…' : '点击下方按钮获取二维码' }}</p>
      <p v-if="status" class="qr-status">{{ status }}</p>
    </div>
    <div class="rc-panel">
      <div class="rc-head">📡 掉线自动重连<small>断线后延迟换 code 自动重连</small></div>
      <div class="rc-row">
        <span id="yyb-scan-enabled">开启自动重连</span>
        <button type="button" class="switch" :class="{ on: config.enabled }" role="switch" :aria-checked="config.enabled" aria-labelledby="yyb-scan-enabled" @click="config.enabled = !config.enabled" />
      </div>
      <div class="rc-grid">
        <div class="rc-col">
          <label class="rc-label" for="yyb-scan-delay">离线多久重连</label>
          <div class="sec-field"><input id="yyb-scan-delay" v-model.number="config.reconnectDelayMin" class="field" type="number" min="1" max="10080"><span class="unit">分钟</span></div>
        </div>
        <div class="rc-col">
          <label class="rc-label" for="yyb-scan-max">失败几次停止</label>
          <div class="sec-field"><input id="yyb-scan-max" v-model.number="config.reconnectMaxAttempts" class="field" type="number" min="1" max="10000"><span class="unit">次</span></div>
        </div>
      </div>
      <div class="rc-foot">
        <span class="rc-state">{{ connection }}</span>
        <div class="rc-btns">
          <button type="button" class="chip" :disabled="retrying || state?.pending || state?.phase === 'online'" @click="retry">{{ retrying ? '重连中…' : '🔁 立即重连' }}</button>
          <button type="button" class="chip" :disabled="saving" @click="save">{{ saving ? '保存中…' : '💾 保存' }}</button>
        </div>
      </div>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button v-if="!scanning" type="button" class="close refresh" @click="start">重新获取二维码</button>
    <button type="button" class="close" @click="emit('close')">关闭</button>
  </section>
</template>

<style scoped>
/* Scoped Go scan-dialog styles; the upstream panel keeps its existing theme. */
.go-yyb-scan {
  --font-sans: "HarmonyOS Sans", "PingFang SC", -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
  --foreground: oklch(0.22 0.02 250); --muted: oklch(0.55 0.012 250);
  --card: oklch(1 0 0 / 0.62); --card-strong: oklch(1 0 0 / 0.85);
  --border: oklch(0.86 0.01 250 / 0.7); --primary: oklch(0.60 0.17 265); --primary-2: oklch(0.55 0.19 285);
  --danger: oklch(0.60 0.20 25); --ease: cubic-bezier(.4,0,.2,1);
  --shadow: 0 8px 30px oklch(0.3 0.04 260 / 0.10), 0 2px 8px oklch(0.3 0.04 260 / 0.06);
  --shadow-sm: 0 2px 10px oklch(0.3 0.04 260 / 0.07);
  width: 100%;
  display: flex; flex-direction: column; overflow-y: auto;
  padding: 18px 18px calc(env(safe-area-inset-bottom) + 16px);
  background: var(--card-strong); backdrop-filter: blur(30px) saturate(1.5);
  border: 1px solid var(--border); border-radius: 24px; box-shadow: var(--shadow);
  color: var(--foreground); font-family: var(--font-sans); line-height: normal;
}
:global(.dark) .go-yyb-scan {
  --foreground: oklch(0.97 0.005 250); --muted: oklch(0.84 0.02 250);
  --card: oklch(0.22 0.03 265 / 0.66); --card-strong: oklch(0.27 0.03 265 / 0.86);
  --border: oklch(0.90 0.015 250 / 0.24); --primary: oklch(0.72 0.14 265); --primary-2: oklch(0.68 0.16 285);
  --danger: oklch(0.72 0.16 25);
  --shadow: 0 10px 34px oklch(0 0 0 / 0.45), 0 2px 10px oklch(0 0 0 / 0.35);
  --shadow-sm: 0 2px 12px oklch(0 0 0 / 0.35);
}
.go-yyb-scan * { box-sizing: border-box; margin: 0; }
.handle { flex: none; width: 42px; height: 5px; border-radius: 999px; background: var(--border); margin: 0 auto 18px; }
h3 { font-size: 17px; font-weight: 700; }
.description { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
.field { width: 100%; min-width: 0; background: var(--card-strong); border: 1px solid var(--border); border-radius: 12px; padding: 11px 13px; color: var(--foreground); font-family: var(--font-sans); font-size: 14px; line-height: normal; outline: none; appearance: none; }
.field:focus { border-color: var(--primary); }
.first-field { margin-top: 12px; }
.next-field { margin-top: 8px; }
.rc-panel { margin-top: 14px; background: var(--card); border: 1px solid var(--border); border-radius: 24px; box-shadow: var(--shadow-sm); padding: 12px 13px; }
.rc-head { display: flex; flex-direction: column; gap: 2px; font-size: 13px; font-weight: 700; margin-bottom: 7px; }
.rc-head small { color: var(--muted); font-weight: 500; font-size: 11px; }
.rc-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0 7px; border-bottom: 1px solid var(--border); }
.rc-row span { font-size: 12.5px; font-weight: 600; }
.rc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 7px; }
.rc-col { min-width: 0; display: flex; flex-direction: column; gap: 5px; background: var(--card-strong); border: 1px solid var(--border); padding: 7px 9px; }
.rc-label { font-size: 11.5px; color: var(--muted); font-weight: 600; }
.sec-field { display: flex; align-items: center; gap: 10px; }
.sec-field .field { padding: 8px 10px; font-size: 13px; width: 100%; }
.unit { flex: none; font-size: 12px; color: var(--muted); }
.switch { flex: none; margin-top: 9px; padding: 0; border: 0; width: 38px; height: 22px; border-radius: 999px; background: var(--border); position: relative; cursor: pointer; transition: background .3s; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .25s var(--ease); box-shadow: 0 1px 3px oklch(0 0 0 / .3); }
.switch.on { background: linear-gradient(90deg, var(--primary), var(--primary-2)); }
.switch.on::after { transform: translateX(16px); }
.error { font-size: 12px; color: var(--danger); margin-top: 10px; }
.close { margin-top: 16px; width: 100%; padding: 13px; border-radius: 16px; border: none; background: var(--card); color: var(--foreground); font-family: var(--font-sans); font-weight: 600; font-size: 14px; cursor: pointer; }
button:disabled, input:disabled { opacity: .6; cursor: wait; }
.qr-area { display:flex; flex-direction:column; align-items:center; padding:16px 0; width:100%; }
.qr-image { width:150px; height:150px; border-radius:12px; background:#fff; object-fit:contain; }
.muted { color:var(--muted); font-size:12px; }
.qr-status { font-size:12px; color:var(--muted); margin-top:8px; text-align:center; }
.rc-foot { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px; }
.rc-state { font-size:11px; color:var(--muted); font-weight:600; flex:1; min-width:0; }
.rc-btns { display:flex; gap:8px; flex:none; }
.chip { background:var(--card-strong); color:var(--muted); border-radius:999px; padding:7px 14px; font-size:12px; font-weight:600; cursor:pointer; font-family:var(--font-sans); transition:all .2s; border:1px solid var(--border); }
.chip:active { transform:scale(.94); }
.close { margin-top:8px; }
.refresh { margin-top:4px; }
@media (max-width:420px) { .go-yyb-scan { padding:14px 12px; } .chip { padding:7px 9px; } .rc-foot { flex-wrap:wrap; } }
</style>
