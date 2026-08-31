import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNpmPath, versionFromTarball } from './registry.ts';

test('普通包名', () => {
  assert.deepEqual(parseNpmPath('node-red-contrib-modbus'),
    { module: 'node-red-contrib-modbus' });
});

test('scope 包的两种写法都要认 —— npm 有时发编码过的斜杠', () => {
  assert.deepEqual(parseNpmPath('@thinglinks/edge-nodes'),
    { module: '@thinglinks/edge-nodes' });
  assert.deepEqual(parseNpmPath('@thinglinks%2fedge-nodes'),
    { module: '@thinglinks/edge-nodes' });
});

test('包体路径切出模块名与文件名', () => {
  assert.deepEqual(parseNpmPath('a-node/-/a-node-1.0.0.tgz'),
    { module: 'a-node', tarball: 'a-node-1.0.0.tgz' });
  assert.deepEqual(parseNpmPath('@s/a/-/a-1.0.0.tgz'),
    { module: '@s/a', tarball: 'a-1.0.0.tgz' });
});

test('文件名里带路径分隔符一律拒绝', () => {
  assert.equal(parseNpmPath('a/-/../../etc/passwd'), undefined);
  assert.equal(parseNpmPath('a/-/'), undefined);
});

test('空路径没有意义', () => {
  assert.equal(parseNpmPath(''), undefined);
  assert.equal(parseNpmPath('/'), undefined);
});

test('从文件名取版本，含预发布标记', () => {
  assert.equal(versionFromTarball('a-node', 'a-node-1.0.0.tgz'), '1.0.0');
  assert.equal(versionFromTarball('a-node', 'a-node-1.0.0-beta.1.tgz'), '1.0.0-beta.1');
  // scope 包的文件名只有最后一段
  assert.equal(versionFromTarball('@s/a', 'a-2.3.4.tgz'), '2.3.4');
});

test('对不上包名的文件名不认', () => {
  assert.equal(versionFromTarball('a-node', 'other-1.0.0.tgz'), undefined);
  assert.equal(versionFromTarball('a-node', 'a-node-1.0.0.zip'), undefined);
  assert.equal(versionFromTarball('a-node', 'a-node-.tgz'), undefined);
});
