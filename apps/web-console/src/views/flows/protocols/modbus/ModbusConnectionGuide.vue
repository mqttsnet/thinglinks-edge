<script setup lang="ts">
import {computed} from 'vue';
import {NAlert,NTag,NSpace} from 'naive-ui';
import {MODBUS_READ_BATCH_SIZE} from './read-limits';
import {reviewModbusConnection} from './connection-review';
const props=defineProps<{values:Record<string,unknown>}>();
const review=computed(()=>reviewModbusConnection(props.values));
</script>

<template>
  <section class="modbus-guide" aria-label="Modbus 连接与读取范围">
    <NSpace :size="8">
      <NTag size="small" :bordered="false">仅采集</NTag>
      <span>{{ review.endpoint || '请填写现场设备地址' }}</span>
      <span v-if="review.range">FC{{ review.range.functionCode }} · 协议地址 {{ review.range.start }}–{{ review.range.end }} · {{ review.range.quantity }} 个寄存器</span>
    </NSpace>
    <p>端口是设备提供服务的端口，无需为此在实例上添加入站端口映射。这里展示配置摘要，设备连通情况仍需实际验证。</p>
    <p v-if="review.batchCount > 1">自动分 {{ review.batchCount }} 批顺序读取，每批最多 {{ MODBUS_READ_BATCH_SIZE }} 个寄存器，全部成功后合并换算。多批读取并非设备同一时刻的原子快照。</p>
    <p v-if="review.range?.reference">常见五位手册编号参考：{{ review.range.reference }}，请以设备手册的编号约定为准。</p>
    <NAlert v-for="notice in review.notices" :key="notice.code" type="warning" :bordered="false" class="notice">{{ notice.message }}</NAlert>
  </section>
</template>

<style scoped>
.modbus-guide { padding: 12px; border: 1px solid var(--border); border-radius: var(--rs); margin: 12px 0; overflow-wrap: anywhere; }
p { font-size: 12px; color: var(--text-2); margin: 8px 0 0; }
.notice { margin-top: 8px; }
</style>
