/**
 * 诊断包组装测试。
 *
 * 核心断言只有一条，其余都是围着它转的：**包里 grep 不到任何明文凭据**。
 * 所以这里刻意把秘密塞得到处都是 —— 配置里、日志里、审计详情里、状态字段里，
 * 然后要求解包后一个都找不着。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, recordAudit } from '../db.ts';
import { untar } from '../archive/tar.ts';
import { collectDiagnostics, BUNDLE_VERSION } from './collect.ts';
import { MASK } from './redact.ts';
import type { EdgeConfig } from '../config.ts';

const MASTER = 'master-key-super-secret-value';
const INSTANCE_PW = 'instance-password-abc123';
const SIGN_KEY = 'sign-key-that-must-not-leak';
const SECRETS = [MASTER, INSTANCE_PW, SIGN_KEY];

const config = (): EdgeConfig => ({
  externalUrl: 'http://127.0.0.1:19100',
  basePath: '',
  cookieSecure: false,
  allowedOrigins: ['http://127.0.0.1:19100'],
  listenAddr: '0.0.0.0',
  listenPort: 19100,
  dataRoot: '/data01/edge',
  dataDir: '/data01/edge/manager',
  instanceDataRoot: '/data01/edge/instances',
  portRange: { min: 30000, max: 30999 },
  timezone: 'Asia/Shanghai',
  updateCheckUrl: 'https://api.github.com/repos/x/y/releases/latest',
});

function source(over: Record<string, unknown> = {}) {
  const db = openDb(':memory:');
  recordAudit(db, { actor: 'admin', action: 'login', result: 'ok' });
  // 审计详情里混进一个秘密：真实世界里这种事就是这么发生的
  recordAudit(db, {
    actor: 'admin', action: 'cloud-config', target: 'broker',
    detail: `signKey=${SIGN_KEY} 已更新`, result: 'ok',
  });
  return {
    config: config(),
    db,
    instances: async () => [{ id: 'line-a', name: '一号产线', credSecret: INSTANCE_PW }],
    health: async () => [{ id: 'line-a', verdict: 'healthy' }],
    hostStats: async () => ({ cpuCount: 8, memPercent: 42 }),
    logs: async () => `[init] 已创建初始账号 admin，初始口令：${INSTANCE_PW}\n[ready] 启动完成\n`,
    cloudStatus: () => ({ state: 'online', brokerUrl: 'mqtt://127.0.0.1:11883', lastError: '' }),
    spoolMetrics: async () => ({ pending: 0, bytes: 0 }),
    secrets: () => SECRETS,
    ...over,
  } as Parameters<typeof collectDiagnostics>[0];
}

/** 解包成 name → 文本 的表，便于逐项断言 */
function unpack(archive: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of untar(archive)) {
    out.set(e.name, Buffer.isBuffer(e.content) ? e.content.toString('utf8') : String(e.content));
  }
  return out;
}

test('包里 grep 不到任何明文凭据 —— 这是验收标准本身', async () => {
  const { archive } = await collectDiagnostics(source(), { actor: 'admin' });
  const whole = archive.toString('utf8');
  for (const s of SECRETS) {
    assert.ok(!whole.includes(s), `诊断包里出现了明文 ${s}`);
  }
  assert.ok(whole.includes(MASK), '应该能看到脱敏标记，否则说明根本没扫到那些字段');
});

test('日志里的初始口令被抹掉，但日志其余内容保留', async () => {
  const { archive } = await collectDiagnostics(source(), { actor: 'admin' });
  const files = unpack(archive);
  const log = files.get('logs/line-a.log');
  assert.ok(log, '应该收集到实例日志');
  assert.ok(!log.includes(INSTANCE_PW));
  assert.match(log, /已创建初始账号 admin/, '脱敏不该把整行删掉，上下文还要能看');
  assert.match(log, /启动完成/);
});

test('审计详情里的 signKey 被抹掉，动作与操作人保留', async () => {
  const { archive } = await collectDiagnostics(source(), { actor: 'admin' });
  const audit = unpack(archive).get('audit.json');
  assert.ok(audit);
  assert.ok(!audit.includes(SIGN_KEY));
  assert.match(audit, /cloud-config/, '审计动作必须留着，否则这张表就没用了');
  assert.match(audit, /admin/);
});

test('环境变量只报键名不报值 —— 值里几乎必然有 MASTER_KEY', async () => {
  process.env['DIAG_TEST_SECRET'] = MASTER;
  try {
    const { archive } = await collectDiagnostics(source(), { actor: 'admin' });
    const runtime = unpack(archive).get('runtime.json');
    assert.ok(runtime);
    assert.match(runtime, /DIAG_TEST_SECRET/, '键名要在，才知道配了哪些东西');
    assert.ok(!runtime.includes(MASTER), '值绝不能出现');
  } finally {
    delete process.env['DIAG_TEST_SECRET'];
  }
});

test('配置走白名单：没列进去的字段不会自动进包', async () => {
  const c = { ...config(), secretFutureField: 'brand-new-secret-value' } as unknown as EdgeConfig;
  const { archive } = await collectDiagnostics(source({ config: c }), { actor: 'admin' });
  const cfg = unpack(archive).get('config.json');
  assert.ok(cfg);
  assert.ok(!cfg.includes('brand-new-secret-value'),
    '白名单的意义就在于以后新增字段默认不外泄');
  assert.match(cfg, /externalUrl/);
});

test('升级检查地址只报「配没配」，不回地址本身', async () => {
  const { archive } = await collectDiagnostics(source(), { actor: 'admin' });
  const cfg = unpack(archive).get('config.json');
  assert.ok(cfg);
  assert.match(cfg, /"updateCheckConfigured": true/);
  assert.ok(!cfg.includes('api.github.com'), '地址可能带内网主机名，不该外泄');
});

/*
 * 闸门必须真的会拦 —— 这条是整个 T4.5 里最重要的断言。
 *
 * 构造方式用的是一个**真实存在的漏网形态**：秘密出现在对象的键名里。
 * redactValue 按设计只脱敏值、不动键名（改键名会把结构弄坏），
 * 所以这种数据一定会带着明文走到最后一步，正好用来验证闸门不是摆设。
 *
 * 现实里什么时候会这样？以接入令牌或 clientId 为 key 的映射就是。
 */
test('闸门真的会拦：秘密出现在键名里时拒绝导出', async () => {
  // 秘密本身与包裹它的字段名都刻意避开 SENSITIVE_KEY 的词表：
  // 一旦命中，redactValue 会把整个子树抹掉，键名就到不了闸门那一步了
  const CID = 'abcdefghijklmnopqrstuvwx';
  const s = source({
    hostStats: async () => ({ byClient: { [CID]: { calls: 12 } } }),
    secrets: () => [...SECRETS, CID],
  });
  await assert.rejects(
    () => collectDiagnostics(s, { actor: 'admin' }),
    /仍含明文凭据/,
    '键名里带凭据时必须拒绝导出，而不是导出一个含凭据的包',
  );
});

test('闸门不误伤：同样的值出现在字段值里能被正常脱敏并导出', async () => {
  const CID = 'abcdefghijklmnopqrstuvwx';
  const s = source({
    hostStats: async () => ({ lastClient: CID }),
    secrets: () => [...SECRETS, CID],
  });
  const { archive } = await collectDiagnostics(s, { actor: 'admin' });
  assert.ok(!archive.toString('utf8').includes(CID));
});

/*
 * 顺带把脱敏「宁可错杀」的那一面也钉住：字段名命中敏感词时整值替换，不看内容。
 * 上面那条用例之所以要刻意避开词表，原因就在这里。
 */
test('字段名命中敏感词时整个子树被抹掉，不看内容', async () => {
  const s = source({ hostStats: async () => ({ perToken: { anything: 'harmless' } }) });
  const { archive } = await collectDiagnostics(s, { actor: 'admin' });
  const host = untar(archive).find((e) => e.name === 'host.json');
  const text = String(host?.content);
  assert.ok(!text.includes('harmless'), 'perToken 命中 token，整个子树都该被抹');
  assert.match(text, /REDACTED/);
});

/*
 * 异常消息最爱把连接串原样吐出来。清单不脱敏的话，一次探测失败就能
 * 把凭据带进包里，然后被闸门拦下 —— 结果是「网络有点问题」升级成
 * 「诊断包根本导不出来」。所以清单必须先脱敏再打包。
 */
test('清单里的失败原因也要脱敏，否则一次报错就让整包导不出来', async () => {
  const s = source({
    health: async () => {
      throw new Error(`connect ECONNREFUSED mqtt://u:${SIGN_KEY}@broker:1883`);
    },
  });
  const { archive, manifest } = await collectDiagnostics(s, { actor: 'admin' });
  assert.ok(!archive.toString('utf8').includes(SIGN_KEY), '清单里漏出了凭据');
  assert.equal(manifest.failures.length, 1, '失败本身仍要如实记录，不能因为脱敏就吞掉');
  assert.match(manifest.failures[0]!.item, /health/);
});

test('单项失败不影响整包，且在清单里如实列出', async () => {
  const s = source({
    health: async () => { throw new Error('探针超时'); },
    hostStats: async () => { throw new Error('读不到 /proc'); },
  });
  const { archive, manifest } = await collectDiagnostics(s, { actor: 'admin' });
  const files = unpack(archive);

  assert.ok(files.has('config.json'), '一处失败不该让整包出不来');
  assert.ok(!files.has('health.json'));
  assert.equal(manifest.failures.length, 2);
  assert.deepEqual(manifest.failures.map((f) => f.item).sort(), ['health', 'hostStats']);
  assert.match(manifest.failures[0]!.error, /探针超时|读不到/);
});

test('清单排在包首位，并列出全部文件', async () => {
  const { archive, manifest } = await collectDiagnostics(source(), { actor: 'ops' });
  const names = untar(archive).map((e) => e.name);
  assert.equal(names[0], 'manifest.json', '解包的人第一眼要看到清单');
  assert.equal(manifest.bundleVersion, BUNDLE_VERSION);
  assert.equal(manifest.generatedBy, 'ops');
  for (const f of manifest.files) {
    assert.ok(names.includes(f), `清单里写了 ${f} 但包里没有`);
  }
});

test('网络探针在未配置云对接时如实说明没探，不编一个结果', async () => {
  const s = source({ cloudStatus: () => null });
  const { archive } = await collectDiagnostics(s, { actor: 'admin' });
  const net = unpack(archive).get('network.json');
  assert.ok(net);
  assert.match(net, /未指定探测目标/);
  assert.match(net, /"probes": \[\]/);
});

test('时钟这一项带上「偏差会伪装成签名错误」的提示', async () => {
  const { archive } = await collectDiagnostics(source(), { actor: 'admin' });
  const clock = unpack(archive).get('clock.json');
  assert.ok(clock);
  assert.match(clock, /验签失败/);
  assert.match(clock, /timezone/);
});

test('云链路那一项写明「探针能证否不能证真」', async () => {
  const { archive } = await collectDiagnostics(source(), { actor: 'admin' });
  const cloud = unpack(archive).get('cloud.json');
  assert.ok(cloud);
  assert.match(cloud, /以 status.state 为准/);
});

test('文件权限是 0600 —— 诊断包落地后不该人人可读', async () => {
  const { archive } = await collectDiagnostics(source(), { actor: 'admin' });
  // tar 头的 mode 字段在偏移 100，占 8 字节：7 位八进制 + NUL
  const mode = archive.subarray(100, 107).toString('utf8');
  assert.equal(mode, '0000600', `期望 0600，实际 ${mode}`);
});
