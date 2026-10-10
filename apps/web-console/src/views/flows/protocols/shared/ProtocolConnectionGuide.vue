<script setup lang="ts">
import {computed} from 'vue';
import {NAlert} from 'naive-ui';
import type {Instance} from '../../../../api/types';
import {reviewProtocolConnection} from './connection-review';
const props=defineProps<{sourceId:string;values:Record<string,unknown>;instance?:Instance|undefined}>();
const review=computed(()=>reviewProtocolConnection(props.sourceId,props.values,props.instance));
</script>
<template>
  <section class="connection-guide" aria-label="协议接入指引">
    <h4>{{ review.title }}</h4>
    <p v-for="line in review.details" :key="line">{{ line }}</p>
    <NAlert v-for="line in review.warnings" :key="line" type="warning" :bordered="false" class="notice">{{ line }}</NAlert>
    <p class="hint">以上核对配置和已有映射，不代表设备已连接。部署后请确认原始报文、转换值及云端接收结果。</p>
  </section>
</template>
<style scoped>
.connection-guide { border:1px solid var(--border);border-radius:var(--rs);padding:12px;margin:12px 0;overflow-wrap:anywhere; }
h4 { margin:0 0 8px;font-size:14px; }
p { margin:8px 0;font-size:13px; }
.hint { color:var(--text-2);font-size:12px; }
.notice { margin:8px 0; }
</style>
