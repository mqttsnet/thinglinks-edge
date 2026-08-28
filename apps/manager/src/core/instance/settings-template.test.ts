import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSettings, type SettingsInput } from './settings-template.ts';

const HASH = '$2b$08$pe27LO/EC6WoXvWkiUEIHej.gnWqZAOOMaP11vLZdI5.0RmC9RZfW';
const input = (over: Partial<SettingsInput> = {}): SettingsInput => ({
  instanceId: 'line-a',
  adminRoot: '/red/line-a/',
  credentials: [{ username: 'admin', passwordHash: HASH, permissions: '*' }],
  credentialSecret: 'secret-abc',
  ...over,
});

/** 把生成的 settings.js 真正 require 进来 —— 只看字符串不算验证过 */
function evalSettings(src: string): Record<string, any> {
  const dir = mkdtempSync(join(tmpdir(), 'tle-settings-'));
  const file = join(dir, 'settings.cjs');
  writeFileSync(file, src, 'utf8');
  return createRequire(import.meta.url)(file);
}

test('生成的文件是合法 JS 且能被 Node 加载', () => {
  const s = evalSettings(renderSettings(input()));
  assert.equal(typeof s, 'object');
  assert.equal(s['flowFile'], 'flows.json');
});

test('httpAdminRoot 与 httpNodeRoot 带上 basePath 前缀', () => {
  const s = evalSettings(renderSettings(input({ adminRoot: '/nodered/red/line-a/' })));
  assert.equal(s['httpAdminRoot'], '/nodered/red/line-a/');
  assert.equal(s['httpNodeRoot'], '/nodered/red/line-a/api/');
});

test('adminAuth 为原生静态凭据，不依赖任何 contrib 包', () => {
  const s = evalSettings(renderSettings(input()));
  assert.equal(s['adminAuth'].type, 'credentials');
  assert.equal(s['adminAuth'].users[0].username, 'admin');
  assert.equal(s['adminAuth'].users[0].password, HASH);
  assert.equal(s['adminAuth'].users[0].permissions, '*');
});

test('拒绝明文口令 —— 只接受 bcrypt 哈希', () => {
  assert.throws(
    () => renderSettings(input({ credentials: [{ username: 'admin', passwordHash: 'secret', permissions: '*' }] })),
    /bcrypt/,
  );
});

test('adminRoot 不以斜杠结尾时拒绝生成', () => {
  assert.throws(() => renderSettings(input({ adminRoot: '/red/line-a' })), /斜杠结尾/);
});

test('无账号时拒绝生成', () => {
  assert.throws(() => renderSettings(input({ credentials: [] })), /至少需要一个/);
});

test('多账号与只读权限', () => {
  const s = evalSettings(renderSettings(input({
    credentials: [
      { username: 'admin', passwordHash: HASH, permissions: '*' },
      { username: 'viewer', passwordHash: HASH, permissions: 'read' },
    ],
  })));
  assert.equal(s['adminAuth'].users.length, 2);
  assert.equal(s['adminAuth'].users[1].permissions, 'read');
});

test('默认屏蔽高危内置节点，可关闭', () => {
  assert.deepEqual(evalSettings(renderSettings(input()))['nodesExcludes'],
    ['90-exec.js', '28-tail.js', '10-file.js', '23-watch.js']);
  assert.deepEqual(evalSettings(renderSettings(input({ excludeRiskyNodes: false })))['nodesExcludes'], []);
});

test('外部模块关闭，收敛 Function 节点可达面', () => {
  const s = evalSettings(renderSettings(input()));
  assert.equal(s['functionExternalModules'], false);
  assert.deepEqual(s['functionGlobalContext'], {});
});

test('特殊字符不会破坏文件结构', () => {
  const s = evalSettings(renderSettings(input({
    instanceId: 'a"b\\c',
    credentials: [{ username: 'ad"min', passwordHash: HASH, permissions: '*' }],
    credentialSecret: 'a"b\nc',
  })));
  assert.equal(s['adminAuth'].users[0].username, 'ad"min');
  assert.equal(s['credentialSecret'], 'a"b\nc');
});

test('settings 指向 @thinglinks 节点集目录', () => {
  // 少了这行，Manager 拷进去的节点集不会被 Node-RED 扫到，
  // 表现是「面板里没有 ThingLinks 分类」而没有任何报错
  assert.equal(evalSettings(renderSettings(input())).nodesDir, '/data/nodes');
});
