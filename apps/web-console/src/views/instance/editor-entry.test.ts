import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory, createRouter } from 'vue-router';
import { NButton } from 'naive-ui';
import { editorEntryProps } from './editor-entry.ts';

function router(base = '/') {
  return createRouter({ history: createMemoryHistory(base), routes: [
    { name: 'instances', path: '/instances', component: { render: () => null } },
  ] });
}
const render = (props: ReturnType<typeof editorEntryProps>) => renderToString(createSSRApp({
  render: () => h(NButton, { ...props, size: 'tiny', type: 'primary' }, () => '打开编辑器'),
}));

test('editor action renders a real new-tab link to the existing password entry without navigating the console', async () => {
  const routes = router('/edge/');
  await routes.push('/instances?scope=line-2');
  const current = routes.currentRoute.value.fullPath;
  const props = editorEntryProps(routes, { id: 'line-1', running: true });
  const html = await render(props);
  assert.match(html, /<a\b/);
  assert.match(html, /href="\/edge\/instances\?editor=line-1"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.equal(routes.currentRoute.value.fullPath, current);
  assert.equal(new URL(props.href!, 'http://console.local').searchParams.get('editor'), 'line-1');
});

test('stopped instances have no navigable href, including middle-click and browser link actions', async () => {
  const props = editorEntryProps(router(), { id: 'line-1', running: false });
  assert.equal(props.disabled, true); assert.equal(props.href, undefined);
  assert.doesNotMatch(await render(props), /\shref=/);
});

test('instance identity stays encoded inside the local entry query and never becomes a navigation URL', () => {
  const id = 'line&redirect=https://outside.invalid/#other';
  const props = editorEntryProps(router('/edge/'), { id, running: true });
  const url = new URL(props.href!, 'http://console.local');
  assert.equal(url.origin, 'http://console.local'); assert.equal(url.pathname, '/edge/instances');
  assert.deepEqual([...url.searchParams.keys()], ['editor']); assert.equal(url.searchParams.get('editor'), id);
  assert.equal(url.hash, '');
});
