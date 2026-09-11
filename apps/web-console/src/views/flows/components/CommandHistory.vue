<script setup lang="ts">
import { toRef } from 'vue';
import { NAlert, NButton, NCollapse, NCollapseItem, NTag } from 'naive-ui';
import type { CloudProductModel, EdgeCommandRecord } from '../../../api/types';
import { localTime } from '../../../api/datetime';
import { useCommandHistory } from '../composables/useCommandHistory';
import { commandReplyStatus, commandStatus } from '../command-status';
const props = defineProps<{ instanceId: string; nodeId: string; model: CloudProductModel | null }>();
const { commands, loading, loaded, error, canLoad, refresh } = useCommandHistory(toRef(props, 'instanceId'), toRef(props, 'nodeId'));
function nameOf(record: EdgeCommandRecord) {
  const name = props.model?.services?.find(service => service.serviceCode === record.serviceCode)?.commands
    ?.find(command => command.commandCode === record.cmd)?.commandName;
  return name ? `${name}（${record.cmd}）` : record.cmd;
}
</script>

<template>
  <NCollapse class="command-history">
    <NCollapseItem title="近期控制记录" name="history">
      <div class="history-heading">
        <p class="hint">按当前目标实例和子设备查询最近 20 条记录。执行结果与回执发布分别显示。</p>
        <NButton size="small" :loading="loading" :disabled="!canLoad" @click="refresh">读取控制记录</NButton>
      </div>
      <NAlert v-if="error" type="warning" :bordered="false">{{ error }}</NAlert>
      <p v-if="!canLoad" class="hint">选择目标实例并填写子设备标识后，可查看该设备的控制记录。</p>
      <p v-else-if="!loaded && !loading && !error" class="hint">尚未读取。此处只查询已有记录，不会发送控制命令。</p>
      <p v-else-if="loaded && !commands.length" class="hint">该实例下的设备暂无可见控制记录。</p>
      <article v-for="record in commands" :key="record.id" class="command-record">
        <div class="record-heading"><b>{{ nameOf(record) }}</b><time>{{ localTime(record.createdAt) }}</time></div>
        <div class="record-states">
          <NTag size="small" :type="commandStatus(record.status).type">{{ commandStatus(record.status).label }}</NTag>
          <NTag size="small" :type="record.modelChecked ? 'info' : 'default'">{{ record.modelChecked ? '已执行模型校验' : '未同步模型校验' }}</NTag>
          <NTag size="small" :type="commandReplyStatus(record).type">{{ commandReplyStatus(record).label }}</NTag>
        </div>
        <p v-if="record.status === 'unknown'" class="hint">{{ commandStatus(record.status).hint }}</p>
        <p v-if="record.error" class="hint">执行说明：{{ record.error }}</p>
        <p v-if="commandReplyStatus(record).hint" class="hint">{{ commandReplyStatus(record).hint }}</p>
      </article>
    </NCollapseItem>
  </NCollapse>
</template>

<style scoped>
.command-history { padding-top: 16px; margin: 16px 0; border-top: 1px solid var(--border); }
.history-heading, .record-heading, .record-states { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.history-heading { justify-content: space-between; margin-bottom: 12px; }
.record-heading { justify-content: space-between; }
.record-heading time { font-size: 12px; color: var(--text-2); }
.record-states { margin-top: 8px; }
.command-record { padding: 12px 0; border-bottom: 1px solid var(--border); }
.hint { color: var(--text-2); font-size: 12px; margin: 6px 0; overflow-wrap: anywhere; }
</style>
