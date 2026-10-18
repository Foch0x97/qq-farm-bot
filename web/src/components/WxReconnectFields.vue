<script setup lang="ts">
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
const model = defineModel<{ enabled: boolean, reconnectDelayMin: number, reconnectMaxAttempts: number }>({ required: true })
</script>
<template>
  <div class="space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
    <BaseSwitch v-model="model.enabled" label="掉线自动重连" />
    <div class="grid grid-cols-2 gap-3">
      <BaseInput v-model="model.reconnectDelayMin" label="首次等待（分钟）" type="number" :min="1" :max="10080" />
      <BaseInput v-model="model.reconnectMaxAttempts" label="最多重连次数" type="number" :min="1" :max="10000" />
    </div>
    <p class="text-xs text-gray-500">成功重连保留计数；游戏请求超时不计上限。被其他登录挤下线时，关闭此开关仍会尝试立即恢复，与 Go 版一致。</p>
  </div>
</template>
