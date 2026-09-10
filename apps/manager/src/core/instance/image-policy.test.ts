import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNodeRedImageTags } from './image-policy.ts';

test('默认支持新版 Node-RED 5.0.7，并保留既有版本可选', () => {
  assert.deepEqual(allowedNodeRedImageTags(), [
    '5.0.7-24-minimal', '5.0.4-24-minimal', '4.1.13-22-minimal',
  ]);
});

test('显式配置仍决定可选版本和顺序，不自动加入默认版本', () => {
  assert.deepEqual(allowedNodeRedImageTags(' custom-24, 5.0.7-24-minimal,custom-24, '), [
    'custom-24', '5.0.7-24-minimal',
  ]);
});

test('显式空配置保持拒绝全部版本，不回退到默认列表', () => {
  assert.deepEqual(allowedNodeRedImageTags(''), []);
  assert.deepEqual(allowedNodeRedImageTags(' , '), []);
});
