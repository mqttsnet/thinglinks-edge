import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlows, summarize } from './parse.ts';
import type { FlowNode } from './types.ts';

const flows = (): FlowNode[] => [
  { id: 'tab1', type: 'tab', label: '一号产线' },
  { id: 'in1', type: 'mqtt in', z: 'tab1', name: '温度', topic: 'plant/temp' },
  { id: 'fn1', type: 'function', z: 'tab1', name: '换算', func: 'return msg;' },
  { id: 'out1', type: 'debug', z: 'tab1', name: '输出' },
];

test('接受字符串与数组两种输入', () => {
  const a = parseFlows(flows());
  const b = parseFlows(JSON.stringify(flows()));
  assert.deepEqual(a, b);
});

test('顶层不是数组要拒绝', () => {
  assert.throws(() => parseFlows({ flows: [] }), /必须是节点数组/);
  assert.throws(() => parseFlows('{"a":1}'), /必须是节点数组/);
});

test('非法 JSON 报错时说清是哪儿的问题', () => {
  assert.throws(() => parseFlows('[{id:1}]'), /不是合法 JSON/);
  assert.throws(() => parseFlows('   '), /内容为空/);
});

test('缺 id 或 type 的节点要拒绝，并指出是第几个', () => {
  assert.throws(() => parseFlows([{ type: 'tab' }]), /第 1 个节点缺少 id/);
  assert.throws(() => parseFlows([{ id: 'a' }]), /节点 a 缺少 type/);
  assert.throws(() => parseFlows(['not-an-object']), /第 1 个元素不是节点对象/);
});

/*
 * 这条防的是一类静默故障：Node-RED 遇到重复 id 不报错，按后来居上覆盖，
 * 于是套用后少了几个节点而界面上毫无提示。必须在入库前就拦下。
 */
test('节点 id 重复必须当场拒绝 —— Node-RED 会静默覆盖', () => {
  assert.throws(
    () => parseFlows([{ id: 'x', type: 'tab' }, { id: 'x', type: 'debug' }]),
    /节点 id 重复：x/,
  );
});

test('体检给出节点数、标签页数与去重排序后的类型', () => {
  const s = summarize(flows());
  assert.equal(s.nodeCount, 4);
  assert.equal(s.tabCount, 1);
  assert.deepEqual(s.nodeTypes, ['debug', 'function', 'mqtt in', 'tab']);
});
