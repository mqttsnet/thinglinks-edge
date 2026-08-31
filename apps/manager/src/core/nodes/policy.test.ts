import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicy, assertModuleName, assertVersionRange, registryEnv, installModeFromEnv, NodePolicyError }
  from './policy.ts';

/*
 * 这一组测试守的是 core/nodes/policy.ts 文件头记的那几条实测结论。
 * 它们看起来像在测「常量还是不是那个常量」——正是如此：
 * 那几个取值一旦被人「优化」掉，白名单会静默失效而没有任何其它信号。
 */

test('denyList 恒为 ["*"] —— 空 denyList 会让 Node-RED 跳过整段白名单校验', () => {
  for (const approved of [[], [{ module: 'node-red-contrib-modbus' }]]) {
    const p = buildPolicy(approved, { allowInstall: true });
    assert.deepEqual(p.denyList, ['*']);
  }
});

test('白名单为空时不是「什么都能装」，而是什么都装不上', () => {
  const p = buildPolicy([], { allowInstall: true });
  assert.deepEqual(p.allowList, []);
  // 关键：denyList 仍然非空，校验因此会执行，而 allowList 里没有任何东西命中
  assert.deepEqual(p.denyList, ['*']);
});

test('带版本的批准项渲染成 name@range', () => {
  const p = buildPolicy(
    [{ module: 'node-red-node-random', version: '~0.4.0' }, { module: 'a-node' }],
    { allowInstall: true },
  );
  assert.deepEqual(p.allowList, ['node-red-node-random@~0.4.0', 'a-node']);
});

test('catalogue 不给就是空数组，而不是回落公网源', () => {
  assert.deepEqual(buildPolicy([], { allowInstall: true }).catalogues, []);
  assert.deepEqual(
    buildPolicy([], { allowInstall: true, catalogueUrl: '/x/c.json' }).catalogues,
    ['/x/c.json'],
  );
});

test('包名里的通配符与正则元字符一律拒绝', () => {
  // 规则字符串会被 Node-RED 拼进正则，放行通配符等于放行一切
  for (const bad of ['*', 'node-red-*', 'a.b*', 'A-Upper', 'has space', '../etc', 'a/b/c', '@s/a/b']) {
    assert.throws(() => assertModuleName(bad), NodePolicyError, `应拒绝：${bad}`);
  }
});

test('合法包名通过，含 scope 与点号', () => {
  for (const ok of ['node-red-contrib-modbus', '@thinglinks/edge-nodes', 'a.b_c-d', 'x0']) {
    assert.doesNotThrow(() => assertModuleName(ok), `应接受：${ok}`);
  }
});

test('超长包名被拒（npm 上限 214）', () => {
  assert.throws(() => assertModuleName('a'.repeat(215)), NodePolicyError);
});

test('版本范围只做字符集校验', () => {
  for (const ok of ['~0.4.0', '^1.2.3', '>=1.0.0 <2.0.0', '*']) {
    assert.doesNotThrow(() => assertVersionRange(ok));
  }
  for (const bad of ['1.0.0; rm -rf /', "1.0.0'", '']) {
    assert.throws(() => assertVersionRange(bad), NodePolicyError);
  }
});

test('registryEnv 用环境变量而不是 .npmrc —— npm info 读不到 /data/.npmrc', () => {
  const env = registryEnv('http://mgr:19100/x/npm/');
  assert.ok(env.includes('NPM_CONFIG_REGISTRY=http://mgr:19100/x/npm/'));
  // 留空表示不配私有源，此时一个变量都不该注入（沿用镜像默认）
  assert.deepEqual(registryEnv(''), []);
});

// ── 安装策略两档 ────────────────────────────────────────

test('open 档必须把 denyList 留空 —— 那才是「整段跳过校验」的正确写法', () => {
  const p = buildPolicy([{ module: 'a' }], { allowInstall: true, mode: 'open' });
  assert.deepEqual(p.denyList, []);
  assert.deepEqual(p.allowList, ['*']);
});

test('不传 mode 时取严的那一档', () => {
  const p = buildPolicy([], { allowInstall: true });
  assert.deepEqual(p.denyList, ['*']);
  assert.deepEqual(p.allowList, []);
});

test('清空批准清单不等于放开 —— 放开必须显式选 open', () => {
  // 早先的实现里，denyList 恒为 ['*'] 就是为了防这个误打误撞
  const p = buildPolicy([], { allowInstall: true, mode: 'allowlist' });
  assert.deepEqual(p.denyList, ['*']);
});

test('策略从环境变量读，非法值取严并不让进程挂掉', () => {
  assert.equal(installModeFromEnv({}), 'allowlist');
  assert.equal(installModeFromEnv({ EDGE_NODE_INSTALL_POLICY: 'open' }), 'open');
  assert.equal(installModeFromEnv({ EDGE_NODE_INSTALL_POLICY: 'OPEN' }), 'open');
  assert.equal(installModeFromEnv({ EDGE_NODE_INSTALL_POLICY: '随便写' }), 'allowlist');
  assert.equal(installModeFromEnv({ EDGE_NODE_INSTALL_POLICY: '' }), 'allowlist');
});
