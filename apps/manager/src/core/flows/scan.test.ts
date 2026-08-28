import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanInlineSecrets } from './scan.ts';
import type { FlowNode } from './types.ts';

const flows = (): FlowNode[] => [
  { id: 'tab1', type: 'tab', label: '一号产线' },
  { id: 'fn1', type: 'function', z: 'tab1', name: '换算', func: 'return msg;' },
];

test('扫得出 function 节点里硬编码的密钥，并指出是哪个节点', () => {
  const hits = scanInlineSecrets([
    ...flows(),
    { id: 'fn2', type: 'function', name: '上云', func: "const apiKey = 'sk-live-0011223344';" },
  ]);
  assert.equal(hits.length, 1);
  assert.match(hits[0]!, /function/);
  assert.match(hits[0]!, /上云/, '必须报出是哪个节点，否则等于让人翻几百个节点');
});

test('干净的模板扫不出东西', () => {
  assert.deepEqual(scanInlineSecrets(flows()), []);
});

test('扫描只告警不改内容 —— 剥离会把 function 代码改坏', () => {
  const src: FlowNode[] = [
    { id: 'fn', type: 'function', name: 'f', func: "const password = 'hunter2xyz';" },
  ];
  const copy = JSON.parse(JSON.stringify(src));
  scanInlineSecrets(src);
  assert.deepEqual(src, copy, '扫描必须是只读的');
});
