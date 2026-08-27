<script setup lang="ts">
/**
 * 表单字段说明图标。
 *
 * 现场作业人员不是这套系统的开发者，字段名再准确也解释不了「填什么、填错会怎样」。
 * 说明文字统一放这里，就近解释，不必跳文档。
 *
 * 写说明时的三条：说清**填错的后果**（很多字段填错不报错，只是行为变怪）、
 * 给**具体例子**而不是抽象定义、写明**能不能改**。
 */
import { NTooltip } from 'naive-ui';
</script>

<template>
  <!--
    z-index 必须显式给：naive-ui 给弹出层的默认值是 auto，而模态框拿到的是 2000。
    于是**模态框里的说明气泡会被模态框自己盖住**——文字只露出模态框外的一小截，
    而构建、类型检查、渲染全部正常。表单里的字段说明恰恰全在模态框里。
  -->
  <NTooltip trigger="hover" placement="top" :z-index="3000" :style="{ maxWidth: '340px' }">
    <template #trigger>
      <!-- tabindex 让键盘也能触发，不是只有鼠标用户才看得到说明 -->
      <span class="fh" tabindex="0" role="note" aria-label="字段说明">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <circle cx="8" cy="8" r="6.9" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path
            d="M5.9 6.1a2.1 2.1 0 1 1 2.75 2c-.42.16-.65.5-.65.94v.36"
            fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"
          />
          <circle cx="8" cy="11.5" r=".85" fill="currentColor" />
        </svg>
      </span>
    </template>
    <div class="fh-body"><slot /></div>
  </NTooltip>
</template>

<style scoped>
.fh {
  display: inline-flex;
  align-items: center;
  margin-left: 5px;
  color: var(--muted);
  cursor: help;
  vertical-align: -1px;
  border-radius: 50%;
  transition: color .15s;
}
.fh:hover,
.fh:focus-visible {
  color: var(--primary);
}
.fh:focus-visible {
  outline: 2px solid rgba(var(--primary-glow), .5);
  outline-offset: 2px;
}
</style>

<style>
/* tooltip 内容在 body 下的传送门里渲染，scoped 够不到，故用全局选择器 */
.fh-body {
  font-size: 12.5px;
  line-height: 1.75;
}
/* div.fh-body 提到 (0,1,2)：外层组件的 scoped 规则会以 code[data-v-x] (0,1,1)
   命中这里的内容，优先级不够就会被它盖掉 */
div.fh-body code {
  background: rgba(255, 255, 255, .16);
  color: #fff;
  padding: 0 4px;
  border-radius: 3px;
  font-family: var(--mono);
  font-size: 11.5px;
}
.fh-body .fh-warn {
  color: var(--warning);
}
.fh-body p {
  margin: 0 0 6px;
}
.fh-body p:last-child {
  margin-bottom: 0;
}
</style>
