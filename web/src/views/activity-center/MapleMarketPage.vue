<script setup lang="ts">
import type { ActivityDirectoryItemDto, ActivityRulesDto } from '@/stores/activity-center'
import { NButton } from 'naive-ui/es/button'
import { NModal } from 'naive-ui/es/modal'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import ActivityRulesDialog from '@/components/activity/ActivityRulesDialog.vue'
import StarSandExchangeDialog from '@/components/activity/StarSandExchangeDialog.vue'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { MAPLE_MARKET_CURRENCY_ICON, MAPLE_MARKET_GOODS, MAPLE_MARKET_ICON } from '@/constants/maple-market'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'
import { purchaseMaxCount } from '@/utils/purchase-count'

const props = defineProps<{ activity: ActivityDirectoryItemDto }>()
defineEmits<{ back: [] }>()

interface MapleMarketOverview {
  rules: ActivityRulesDto | null
  initialPrice: number | null
  currentPrice: number | null
  shareBonus: number | null
  seedsClaimed: boolean | null
  sharedToday: boolean | null
  claimedSeedCount: number | null
  shareSeedCount: number | null
  coinBalance: string | null
  remainingPurchaseQuota: string | null
  settlement: { quantity: string, coins: string } | null
  catalog: { coinBalance: string, goods: { index: number, price: number, limit: number, remaining: number }[] } | null
}

interface MaplePurchaseRecord {
  timestamp: number
  name: string
  quantity: string
  total: string
  commission: string
}

const tab = ref('rules')
const showRecords = ref(false)
const purchaseRecords = ref<MaplePurchaseRecord[]>([])
const recordsLoading = ref(false)
const recordsError = ref('')
const overview = ref<MapleMarketOverview | null>(null)
const loadError = ref('')
const showRules = ref(false)
const loading = ref(false)
const pendingAction = ref(false)
const dailyAutoShare = ref<boolean | null>(null)
const autoShareSaving = ref(false)
const toast = useToastStore()
const selectedExchange = ref<{ index: number, price: number, remaining: number } | null>(null)
const refreshCount = ref(0)
const { currentAccountId } = storeToRefs(useAccountStore())

watch(currentAccountId, async (accountId, _, onCleanup) => {
  dailyAutoShare.value = null
  if (!accountId)
    return
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const config = { headers: { 'x-account-id': accountId }, signal: controller.signal, skipErrorToast: true }
  try {
    const { data } = await api.get<{ ok: boolean, data?: { automation?: { maple_auto_share?: boolean } }, error?: string }>(
      '/api/settings', config,
    )
    if (controller.signal.aborted)
      return
    if (!data.ok || !data.data)
      throw new Error(data.error || '无法读取自动分享设置')
    dailyAutoShare.value = data.data.automation?.maple_auto_share === true
  }
  catch (error) {
    if (!controller.signal.aborted)
      toast.error(getApiErrorMessage(error, '无法读取自动分享设置'))
  }
}, { immediate: true })

async function saveDailyAutoShare(value: boolean | undefined) {
  const accountId = currentAccountId.value
  if (!accountId || typeof value !== 'boolean' || dailyAutoShare.value == null || autoShareSaving.value)
    return
  autoShareSaving.value = true
  const config = { headers: { 'x-account-id': accountId }, timeout: 15000, skipErrorToast: true }
  try {
    const { data } = await api.post<{ ok: boolean, saved?: boolean, error?: string }>(
      '/api/settings/save', { automation: { maple_auto_share: value } }, config,
    )
    if (currentAccountId.value !== accountId)
      return
    if (data.ok || data.saved)
      dailyAutoShare.value = value
    if (!data.ok) {
      if (data.saved)
        toast.warning(data.error || '设置已保存，等待账号确认')
      else
        throw new Error(data.error || '自动分享设置保存失败')
    }
    else {
      toast.success(value ? '已开启每日自动分享' : '已关闭每日自动分享')
    }
  }
  catch (error) {
    if (currentAccountId.value === accountId)
      toast.error(getApiErrorMessage(error, '自动分享设置保存失败'))
  }
  finally {
    autoShareSaving.value = false
  }
}

watch([currentAccountId, refreshCount], async ([accountId], [previousAccountId], onCleanup) => {
  if (accountId !== previousAccountId) {
    overview.value = null
    showRules.value = false
    showRecords.value = false
    selectedExchange.value = null
  }
  loadError.value = ''
  loading.value = Boolean(accountId)
  if (!accountId)
    return
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const config = { headers: { 'x-account-id': accountId }, signal: controller.signal, skipErrorToast: true }
  try {
    const { data } = await api.get<{ ok: boolean, data?: MapleMarketOverview, error?: string }>(
      '/api/activity-center/maple-market',
      config,
    )
    if (controller.signal.aborted)
      return
    if (!data.ok || !data.data)
      throw new Error(data.error || '暂时无法读取小铺数据')
    overview.value = data.data
  }
  catch (error) {
    if (!controller.signal.aborted) {
      overview.value = null
      loadError.value = getApiErrorMessage(error, '暂时无法读取小铺数据')
    }
  }
  finally {
    if (!controller.signal.aborted)
      loading.value = false
  }
}, { immediate: true })
watch([showRecords, currentAccountId], async ([open, accountId], _, onCleanup) => {
  if (!open || !accountId)
    return
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  recordsLoading.value = true
  recordsError.value = ''
  purchaseRecords.value = []
  const config = { headers: { 'x-account-id': accountId }, signal: controller.signal, skipErrorToast: true }
  try {
    const { data } = await api.get<{ ok: boolean, data?: MaplePurchaseRecord[], error?: string }>(
      '/api/activity-center/maple-market/purchase-records', config,
    )
    if (controller.signal.aborted)
      return
    if (!data.ok || !Array.isArray(data.data))
      throw new Error(data.error || '无法获取收购记录')
    purchaseRecords.value = data.data
  }
  catch (error) {
    if (!controller.signal.aborted)
      recordsError.value = getApiErrorMessage(error, '无法获取收购记录')
  }
  finally {
    if (!controller.signal.aborted)
      recordsLoading.value = false
  }
})

const exchangeGoods = computed(() => {
  const catalog = new Map(overview.value?.catalog?.goods.map(item => [item.index, item]))
  return MAPLE_MARKET_GOODS.map(item => ({
    ...item,
    price: catalog.get(item.index)?.price ?? item.price,
    limit: catalog.get(item.index)?.limit ?? item.limit,
    remaining: catalog.get(item.index)?.remaining ?? null,
  }))
})
const exchangeBalance = computed(() => overview.value?.catalog?.coinBalance ?? null)
const currency = { id: '1033', name: '福气币', count: '0', image: MAPLE_MARKET_CURRENCY_ICON, rarity: 0 }
const exchangeShop = computed(() => ({
  currency,
  currencies: [],
  balance: exchangeBalance.value,
  balanceKnown: exchangeBalance.value != null,
}))

function exchangeMax(item: { remaining: number | null, price: number }) {
  return purchaseMaxCount({
    limitRemaining: item.remaining ?? 0,
    costs: [{ count: item.price, balance: exchangeBalance.value }],
  })
}

function canExchange(item: { remaining: number | null, price: number }) {
  return !loading.value && !pendingAction.value && exchangeMax(item) > 0
}

const dialogGoods = computed(() => {
  const selected = selectedExchange.value
  const item = exchangeGoods.value.find(row => row.index === selected?.index)
  if (!selected || !item)
    return null
  return {
    id: String(item.index),
    name: item.name,
    item: { id: String(item.id), name: item.name, count: '1', image: item.image, rarity: 0 },
    cost: { ...currency, count: String(selected.price) },
    balanceKnown: exchangeBalance.value != null,
    maxExchangeCountKnown: true,
    maxExchangeCount: String(exchangeMax(selected)),
  }
})

function openExchange(item: (typeof exchangeGoods.value)[number]) {
  if (item.remaining != null && canExchange(item))
    selectedExchange.value = { index: item.index, price: item.price, remaining: item.remaining }
}

function confirmExchange(id: string, count: number) {
  const selected = selectedExchange.value
  if (selected && String(selected.index) === id)
    return submitAction('exchange', { ...selected, count })
}

async function submitAction(action: 'claim-seeds' | 'share' | 'exchange', payload?: object) {
  const accountId = currentAccountId.value
  if (!accountId || pendingAction.value || loading.value)
    return
  pendingAction.value = true
  try {
    const config = { headers: { 'x-account-id': accountId }, skipErrorToast: true }
    const { data } = await api.post<{
      ok: boolean
      data?: { reward: { count: number, itemId: number }, rewardName?: string, coinBalance?: string | null }
      error?: string
    }>(`/api/activity-center/maple-market/${action}`, payload ?? {}, config)
    if (!data.ok || !data.data)
      throw new Error(data.error || '未能确认操作结果，请先刷新核对')
    if (currentAccountId.value === accountId) {
      const { count, itemId } = data.data.reward
      const { coinBalance } = data.data
      if (action === 'exchange' && coinBalance != null && overview.value) {
        overview.value.coinBalance = coinBalance
        if (overview.value.catalog)
          overview.value.catalog.coinBalance = coinBalance
      }
      const name = data.data.rewardName || MAPLE_MARKET_GOODS.find(item => item.id === itemId)?.name || `道具 #${itemId}`
      const messages = {
        'claim-seeds': `已领取 ${count} 粒红薯种子`,
        'share': `分享奖励，获得 ${count} 粒红薯种子`,
        'exchange': `兑换成功，获得 ${name} ×${numberFormat.format(count)}`,
      }
      toast.success(messages[action])
    }
  }
  catch (error) {
    if (currentAccountId.value === accountId)
      toast.error(getApiErrorMessage(error, '未能确认操作结果，请先刷新核对'))
  }
  finally {
    pendingAction.value = false
    if (currentAccountId.value === accountId) {
      if (action === 'exchange')
        selectedExchange.value = null
      refreshCount.value++
    }
  }
}

const seedStatus = computed(() => {
  const claimed = overview.value?.seedsClaimed
  if (claimed == null)
    return '领取状态未获取'
  if (!claimed)
    return '今日待领取'
  const count = overview.value?.claimedSeedCount
  return count == null ? '今日已领取' : `今日已领取 ${priceText(count)} 粒红薯种子`
})
const settlementText = computed(() => {
  const settlement = overview.value?.settlement
  if (!settlement)
    return ''
  return `已自动收购 ${amountText(settlement.quantity)} 个蜜薯，获得 ${amountText(settlement.coins)} 福气币。`
})
const steps = computed(() => [
  { title: '领取种子', icon: 'i-carbon-sprout', status: seedStatus.value, copy: '每日首次进入小铺可领红薯种子。收获红薯时会额外获得蜜薯。' },
  { title: '分享提价', icon: 'i-carbon-share', copy: '首次分享可提高当天的收购价，并获得红薯种子奖励。' },
  { title: '出售与分红', icon: 'i-carbon-store', copy: '自家小铺不限收购量。卖给好友会占用对方的收购额度，店主可获得福气币分红。未领取的分红可由游戏邮件补发。' },
  { title: '每日结算', icon: 'i-carbon-time', status: settlementText.value, copy: '每日 24:00，剩余蜜薯按自己小铺的最终收购价结算为福气币。' },
])
const numberFormat = new Intl.NumberFormat('zh-CN')
function amountText(amount: string | null | undefined) {
  return amount != null && /^\d+$/.test(amount) ? numberFormat.format(BigInt(amount)) : '未获取'
}
function priceText(price: number | null | undefined) {
  return price == null ? '未获取' : numberFormat.format(price)
}
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Asia/Shanghai',
})
const activityPeriod = computed(() => {
  const { startTime, endTime } = props.activity
  const start = startTime !== null && startTime > 0 ? dateFormat.format(startTime) : '未获取'
  const end = endTime !== null && endTime > 0 ? dateFormat.format(endTime) : '未获取'
  return `${start} – ${end}（UTC+8）`
})
</script>

<template>
  <section class="maple">
    <header class="maple-head">
      <NButton quaternary circle aria-label="返回活动列表" title="返回活动列表" @click="$emit('back')">
        <template #icon>
          <span class="i-carbon-arrow-left" />
        </template>
      </NButton>
      <img :src="MAPLE_MARKET_ICON" width="32" height="32" alt="">
      <div class="maple-head__title">
        <h1>{{ activity.name }}</h1>
        <p><span class="i-carbon-calendar" aria-hidden="true" />{{ activityPeriod }}</p>
      </div>
      <NButton v-if="overview?.rules" secondary size="small" @click="showRules = true">
        活动说明
      </NButton>
      <NButton
        quaternary circle :loading="loading" :disabled="!currentAccountId"
        aria-label="刷新活动数据" title="刷新活动数据" @click="refreshCount++"
      >
        <template #icon>
          <span class="i-carbon-renew" />
        </template>
      </NButton>
    </header>

    <NTabs v-model:value="tab" type="line" class="maple-tabs" aria-label="以薯换福玩法">
      <NTab name="rules">
        <span class="maple-tab"><span class="i-carbon-store" aria-hidden="true" />红薯小铺</span>
      </NTab>
      <NTab name="shop">
        <span class="maple-tab"><span class="i-carbon-gift" aria-hidden="true" />兑换商店</span>
      </NTab>
    </NTabs>

    <div class="maple-content">
      <p v-if="loadError" class="maple-note" role="status">{{ loadError }}</p>
      <template v-if="tab === 'rules'">
        <section class="maple-card">
          <header class="maple-overview">
            <div>
              <h2>今日蜜薯收购价</h2>
              <p v-if="overview?.sharedToday">今日已分享</p>
            </div>
            <div class="maple-share-controls">
              <BaseSwitch
                :model-value="dailyAutoShare ?? false"
                :disabled="dailyAutoShare == null || autoShareSaving"
                label="每日自动分享"
                @update:model-value="saveDailyAutoShare"
              />
              <NButton
                secondary
                :disabled="!overview?.seedsClaimed || overview.sharedToday !== false || pendingAction || loading"
                @click="submitAction('share')"
              >
                <template #icon>
                  <span class="i-carbon-share" />
                </template>
                分享
              </NButton>
            </div>
          </header>
          <dl class="maple-quote">
            <div><dt>初始收购价</dt><dd>{{ priceText(overview?.initialPrice) }}</dd></div>
            <div><dt>当前收购价</dt><dd>{{ priceText(overview?.currentPrice) }}</dd></div>
            <div><dt>分享加价</dt><dd>{{ priceText(overview?.shareBonus) }}</dd></div>
            <div><dt>分享奖励种子</dt><dd>{{ priceText(overview?.shareSeedCount) }}</dd></div>
          </dl>
        </section>

        <div class="maple-records-trigger">
          <p class="maple-note">还可收购 <strong>{{ amountText(overview?.remainingPurchaseQuota) }}<span v-if="overview?.remainingPurchaseQuota != null"> 个</span></strong></p>
          <NButton secondary size="small" :disabled="!currentAccountId" @click="showRecords = true">
            <template #icon><span class="i-carbon-list" /></template>
            收购记录
          </NButton>
        </div>

        <div class="maple-grid">
          <section v-for="step in steps" :key="step.title" class="maple-card maple-step">
            <span class="maple-step__icon" aria-hidden="true"><span :class="step.icon" /></span>
            <div>
              <h3>{{ step.title }}</h3>
              <p v-if="step.status">{{ step.status }}</p>
              <p>{{ step.copy }}</p>
              <NButton
                v-if="step.title === '领取种子' && overview?.seedsClaimed === false"
                secondary size="small" :disabled="pendingAction || loading" @click="submitAction('claim-seeds')"
              >
                领取
              </NButton>
            </div>
          </section>
        </div>
      </template>

      <template v-else>
        <div class="maple-shop-heading">
          <p id="maple-exchange-status" class="maple-note">
            <span class="i-carbon-information" aria-hidden="true" />
            {{ overview?.catalog ? '剩余可兑 / 限购总量' : '剩余可兑 / 限购总量。剩余次数尚未获取。' }}
          </p>
          <p class="maple-shop-balance">
            <img :src="MAPLE_MARKET_CURRENCY_ICON" width="18" height="18" alt="">
            福气币余额 <strong>{{ amountText(exchangeBalance ?? overview?.coinBalance) }}</strong>
          </p>
        </div>

        <ul class="maple-grid" aria-label="兑换商品">
          <li v-for="item in exchangeGoods" :key="item.id" class="maple-card maple-good">
            <CommerceItemImage :src="item.image" />
            <div class="maple-good__main">
              <h3>{{ item.name }}</h3>
              <div class="maple-good__limit">
                {{ item.remaining ?? '未获取' }}/{{ item.limit }}
              </div>
            </div>
            <div class="maple-good__action">
              <span class="maple-good__price" :aria-label="`${item.price} 福气币`">
                <img :src="MAPLE_MARKET_CURRENCY_ICON" width="18" height="18" alt="">
                <strong>{{ numberFormat.format(item.price) }}</strong>
              </span>
              <NButton size="small" secondary :disabled="!canExchange(item)" :aria-label="`兑换${item.name}`" @click="openExchange(item)">
                兑换
              </NButton>
            </div>
          </li>
        </ul>
      </template>
    </div>

    <NModal v-model:show="showRecords" preset="card" title="收购记录" style="width: min(460px, calc(100vw - 32px))">
      <p v-if="recordsLoading" class="maple-note" role="status">正在读取收购记录…</p>
      <p v-else-if="recordsError" class="maple-note" role="alert">{{ recordsError }}</p>
      <p v-else-if="!purchaseRecords.length" class="maple-note">暂无收购记录</p>
      <ul v-else class="maple-records">
        <li v-for="(entry, index) in purchaseRecords" :key="index">
          <strong>{{ entry.name || '收购记录' }}</strong>
          <p>蜜薯 {{ amountText(entry.quantity) }} 个 · 福气币 {{ amountText(entry.total) }}</p>
          <p v-if="entry.commission !== '0'">分红 {{ amountText(entry.commission) }} 福气币</p>
          <time v-if="entry.timestamp > 0 && entry.timestamp <= 8640000000000">{{ dateFormat.format(entry.timestamp * 1000) }}</time>
        </li>
      </ul>
    </NModal>
    <StarSandExchangeDialog
      :open="!!selectedExchange" :goods="dialogGoods" :shop="exchangeShop" :pending="pendingAction"
      @close="selectedExchange = null" @confirm="confirmExchange"
    />
    <ActivityRulesDialog :open="showRules" :rules="overview?.rules" @close="showRules = false" />
  </section>
</template>

<style scoped>
.maple-share-controls { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px 12px; }

.maple-records-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.maple-records { display: grid; gap: 12px; max-height: 60vh; overflow: auto; margin: 0; padding: 0; list-style: none; }
.maple-records li { padding: 10px 12px; border: 1px solid var(--ui-border); border-radius: 10px; }
.maple-records p, .maple-records time { color: var(--ui-muted); font-size: 12px; }

.maple {
  min-width: 0;
  padding-bottom: 24px;
}

.maple :is(h1, h2, h3, p) {
  margin: 0;
}

.maple-head {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 10px;
  padding-top: 16px;
}

.maple-head > img {
  flex: none;
  object-fit: contain;
}

.maple-head__title {
  min-width: 0;
}

.maple-head h1 {
  color: var(--ui-ink);
  font-size: 22px;
  font-weight: var(--fw-700);
  line-height: 1.3;
}

.maple-head p,
.maple-note {
  display: flex;
  align-items: baseline;
  gap: 5px;
  color: var(--ui-muted);
  font-size: 12px;
}

.maple-note > span,
.maple-head p > span {
  flex: none;
}

.maple-shop-heading,
.maple-shop-balance {
  display: flex;
  align-items: center;
}

.maple-shop-heading {
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
}

.maple-shop-balance {
  gap: 6px;
  color: var(--ui-muted);
  font-size: 12px;
}

.maple-shop-balance strong {
  color: var(--ui-ink);
}

.maple-tabs {
  margin-top: 8px;
}

.maple-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.maple-content {
  display: grid;
  gap: 12px;
  padding-top: 16px;
}

.maple-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.maple-card {
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-card);
  background: var(--ui-surface);
  box-shadow: var(--ui-shadow-sm);
}

.maple-card h2,
.maple-card h3 {
  color: var(--ui-ink);
  font-size: 14px;
  font-weight: var(--fw-700);
}

.maple-card p {
  margin-top: 4px;
  color: var(--ui-muted);
  font-size: 13px;
  line-height: 1.6;
}

.maple-overview,
.maple-step {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.maple-overview {
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
}

.maple-quote {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
}

.maple-quote dt {
  color: var(--ui-muted);
  font-size: 12px;
}

.maple-quote dd {
  margin: 4px 0 0;
  color: var(--ui-ink);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  font-weight: var(--fw-700);
}

.maple-step__icon {
  display: grid;
  width: 36px;
  height: 36px;
  flex: none;
  place-items: center;
  border-radius: var(--ui-radius-control);
  color: var(--ui-muted);
  background: var(--ui-surface-soft);
  font-size: 18px;
}

.maple-good {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}

.maple-good__limit {
  margin-top: 4px;
  color: var(--ui-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.maple-good__action {
  display: grid;
  justify-items: end;
  gap: 6px;
}

.maple-good__price {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-ink);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.maple-good__price img {
  object-fit: contain;
}

@media (max-width: 960px) {
  .maple-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 600px) {
  .maple-quote {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .maple-card {
    padding: 12px;
  }

  .maple-good {
    gap: 8px;
  }

  .maple-good :deep(.item-image) {
    width: 44px;
    height: 44px;
  }
}
</style>
