<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { ref } from 'vue'
import CommerceItemImage from '@/components/commerce/CommerceItemImage.vue'
import { MAPLE_MARKET_CURRENCY_ICON, MAPLE_MARKET_GOODS, MAPLE_MARKET_ICON } from '@/constants/maple-market'

defineEmits<{ back: [] }>()

const tab = ref('rules')
const steps = [
  { title: '领取种子', icon: 'i-carbon-sprout', copy: '每日首次进入小铺可领基础 28 粒红薯种子。收获红薯时会额外获得蜜薯。' },
  { title: '分享提价', icon: 'i-carbon-share', copy: '首次分享可提高当天的收购价，并获得红薯种子奖励。' },
  { title: '出售与分红', icon: 'i-carbon-store', copy: '自家小铺不限收购量。卖给好友会占用对方的收购额度，店主可获得 2% 的福气币分红。未领取的分红可由游戏邮件补发。' },
  { title: '每日结算', icon: 'i-carbon-time', copy: '每日 24:00，剩余蜜薯按自己小铺的最终收购价结算为福气币。' },
]
const numberFormat = new Intl.NumberFormat('zh-CN')
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
        <h1>以薯换福</h1>
        <p><span class="i-carbon-calendar" aria-hidden="true" />11 月 25 日 10:00 – 12 月 9 日 24:00（UTC+8）</p>
      </div>
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
      <template v-if="tab === 'rules'">
        <section class="maple-card">
          <header class="maple-overview">
            <div>
              <h2>今日蜜薯收购价</h2>
              <p>小铺行情与分享奖励接口待接入</p>
            </div>
            <NButton secondary disabled>
              <template #icon>
                <span class="i-carbon-share" />
              </template>
              分享
            </NButton>
          </header>
          <dl class="maple-quote">
            <div><dt>初始收购价</dt><dd>—</dd></div>
            <div><dt>当前收购价</dt><dd>—</dd></div>
            <div><dt>分享加价</dt><dd>—</dd></div>
            <div><dt>分享奖励种子</dt><dd>—</dd></div>
          </dl>
        </section>

        <div class="maple-grid">
          <section v-for="step in steps" :key="step.title" class="maple-card maple-step">
            <span class="maple-step__icon" aria-hidden="true"><span :class="step.icon" /></span>
            <div>
              <h3>{{ step.title }}</h3>
              <p>{{ step.copy }}</p>
            </div>
          </section>
        </div>
      </template>

      <template v-else>
        <p id="maple-exchange-status" class="maple-note">
          <span class="i-carbon-information" aria-hidden="true" />
          卡片显示面板已兑换数量 / 活动限购总量。游戏内兑换记录尚未同步。
        </p>

        <ul class="maple-grid" aria-label="兑换商品">
          <li v-for="item in MAPLE_MARKET_GOODS" :key="item.id" class="maple-card maple-good">
            <CommerceItemImage :src="item.image" />
            <div class="maple-good__main">
              <h3>{{ item.name }}</h3>
              <div class="maple-good__limit" :aria-label="`面板已兑换 0 份，活动限购 ${item.limit} 份`">
                0/{{ item.limit }}
              </div>
            </div>
            <div class="maple-good__action">
              <span class="maple-good__price" :aria-label="`${item.price} 福气币`">
                <img :src="MAPLE_MARKET_CURRENCY_ICON" width="18" height="18" alt="">
                <strong>{{ numberFormat.format(item.price) }}</strong>
              </span>
              <NButton size="small" secondary disabled :aria-label="`兑换${item.name}`" aria-describedby="maple-exchange-status">
                兑换
              </NButton>
            </div>
          </li>
        </ul>
      </template>
    </div>

  </section>
</template>

<style scoped>
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
