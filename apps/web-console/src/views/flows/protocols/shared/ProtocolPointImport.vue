<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {NAlert,NButton,NInput,NTable} from 'naive-ui';
import type {TemplateParameter} from '../../../../api/types';
import {previewPointImport,applyPointImport,type PointImportPreview} from './point-import';
const props=defineProps<{schema:TemplateParameter;values:Record<string,unknown>;disabled?:boolean}>();
const emit=defineEmits<{'update:values':[values:Record<string,unknown>]}>();
const text=ref(''),preview=ref<PointImportPreview|null>(null),applied=ref('');
const types=computed(()=>props.schema.columns?.find(c=>c.key==='dataType')?.options??[]);
const sourceLabel=computed(()=>props.schema.columns?.find(c=>c.key==='source')?.label??'地址或源字段');
const canApply=computed(()=>preview.value&&preview.value.rows.length>0&&!preview.value.issues.length);
watch(text,()=>{preview.value=null;applied.value='';});
watch(()=>[props.values,props.schema],()=>{preview.value=null;},{deep:true,flush:'sync'});
function example(){
  const point=(props.schema.default as Record<string,unknown>[]|undefined)?.[0];
  const source=props.values.format==='binary'?'0':String(point?.source??'temperature');
  const type=props.values.format==='binary'?types.value.find(t=>String(t.value).includes('16'))?.value:point?.dataType;
  text.value=`地址\t属性编码\t数据类型\t倍率\t偏移\n${source}\ttemperature\t${type??types.value[0]?.value??'number'}\t1\t0`;
}
function inspect(){if(!props.disabled){applied.value='';preview.value=previewPointImport(text.value,props.schema,props.values);}}
function apply(){if(props.disabled||!canApply.value||!preview.value)return;const count=preview.value.rows.length;emit('update:values',applyPointImport(props.values,preview.value));preview.value=null;applied.value=`已替换 ${count} 个点位，请继续核对服务与属性编码，并检查参数预览。`;}
</script>
<template>
  <details class="point-import">
    <summary>从 Excel / CSV 导入点表</summary>
    <div class="body">
      <p>复制五列：{{ sourceLabel }}、属性编码、数据类型、倍率、偏移，包含表头。最多 64 个点；倍率和偏移留空时为 1 和 0。</p>
      <NInput v-model:value="text" type="textarea" :disabled="disabled" :input-props="{'aria-label':'粘贴协议点表'}" :autosize="{minRows:4,maxRows:9}" placeholder="source,property,dataType,scale,offset" />
      <p v-if="sourceLabel.includes('PLC')" class="hint">PLC 地址含逗号时使用 Excel 分列粘贴，或在 CSV 中写成 &quot;DB1,REAL0&quot;。</p>
      <p class="hint">按当前协议填写地址或源字段；导入只替换点表，不修改设备连接和云端配置。</p>
      <details><summary>可用数据类型</summary><p>{{ types.map(t=>`${t.value}（${t.label}）`).join('、') }}</p></details>
      <div class="actions"><NButton size="small" :disabled="disabled" @click="example">填入示例点表</NButton><NButton size="small" type="primary" secondary :disabled="disabled||!text.trim()" @click="inspect">预览导入</NButton></div>
      <NAlert v-if="preview?.issues.length" type="error" :bordered="false"><ul><li v-for="issue in preview.issues" :key="issue">{{ issue }}</li></ul><p>修正后重新预览，当前点表已保留。</p></NAlert>
      <template v-if="preview?.rows.length">
        <div class="table" role="region" aria-label="协议点表导入预览" tabindex="0"><NTable size="small"><thead><tr><th>文本行</th><th>{{ sourceLabel }}</th><th>属性编码</th><th>类型</th><th>倍率</th><th>偏移</th></tr></thead><tbody><tr v-for="row in preview.rows" :key="row.line"><td>{{ row.line }}</td><td>{{ row.point.source }}</td><td>{{ row.point.property }}</td><td>{{ row.point.dataType }}</td><td>{{ row.point.scale }}</td><td>{{ row.point.offset }}</td></tr></tbody></NTable></div>
        <p class="hint">这是点表格式预览；协议地址的完整校验在保存配置或预览部署时执行，设备数据仍需实际验证。</p>
        <NButton v-if="canApply" size="small" type="primary" :disabled="disabled" @click="apply">确认替换 {{ preview.rows.length }} 个点位</NButton>
      </template>
      <NAlert v-if="applied" type="success" :bordered="false">{{ applied }}</NAlert>
    </div>
  </details>
</template>
<style scoped>
.point-import { min-width:0;border:1px solid var(--border);border-radius:var(--rs);margin-bottom:16px;overflow-wrap:anywhere; }
.point-import>summary { padding:12px;font-weight:600;cursor:pointer; }
.body { padding:0 12px 12px; } p {font-size:12px;margin:8px 0 12px;}.hint{color:var(--text-2);}
summary {cursor:pointer;}.actions {display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;}.table{overflow:auto;max-height:320px;margin:12px 0;}.table table{min-width:640px;}ul{padding-left:20px;margin:0;}
</style>
