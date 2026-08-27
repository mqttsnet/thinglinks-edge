<script setup lang="ts">
/**
 * 升级说明渲染。
 *
 * 刻意**不引 Markdown 库**：离线安装是既定目标，为一个弹窗多背一个依赖不划算。
 * 这里只认使用者说明实际会用到的几种写法 —— 二级标题、无序列表、
 * 粗体、行内代码。写说明时别超出这个范围。
 *
 * 内容虽然来自镜像内的文件（不是用户输入），仍然先转义再替换：
 * 顺序反过来就会把生成的标签自己转义掉，而且日后万一内容来源变了，
 * 这层已经在了。
 */
import { computed } from 'vue';

const props = defineProps<{ source: string }>();

function escapeHtml(t: string): string {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 行内标记：先转义，再把 **粗体** 与 `代码` 换成标签 */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

const html = computed(() => {
  const out: string[] = [];
  // 先剥 HTML 注释：变更说明文件里放着写给作者的编辑约定，
  // 那是给写的人看的，不该出现在给现场人员看的弹窗里
  const source = props.source.replace(/<!--[\s\S]*?-->/g, '');
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of source.split('\n')) {
    const line = raw.trimEnd();

    if (line.trim() === '') { closeList(); continue; }

    // 一级标题就是版本号，弹窗标题已经写了，这里跳过避免重复
    if (/^#\s/.test(line)) { closeList(); continue; }

    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) { closeList(); out.push(`<h4>${inline(h2[1] ?? '')}</h4>`); continue; }

    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1] ?? '')}</li>`);
      continue;
    }

    // 列表项的续行：并进上一条，而不是另起一段
    if (inList && /^\s+\S/.test(raw)) {
      const last = out.pop() ?? '';
      out.push(last.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`));
      continue;
    }

    closeList();
    out.push(`<p>${inline(line.trim())}</p>`);
  }
  closeList();
  return out.join('');
});
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- 内容由上面的受控子集生成，已转义 -->
  <div class="rn" v-html="html" />
</template>

<style scoped>
.rn { font-size: 13.5px; line-height: 1.85; color: var(--text-2); }
.rn :deep(h4) {
  margin: 14px 0 6px;
  font-size: 13px;
  color: var(--text);
}
.rn :deep(h4:first-child) { margin-top: 0; }
.rn :deep(p) { margin: 0 0 8px; }
.rn :deep(ul) { margin: 0 0 8px; padding-left: 18px; }
.rn :deep(li) { margin-bottom: 5px; }
.rn :deep(strong) { color: var(--text); font-weight: 600; }
.rn :deep(code) {
  background: var(--grey100);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 12px;
}
</style>
