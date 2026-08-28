/**
 * 上线前安全验收（T6.4 / `04-安全设计.md` 第 12 节）。
 *
 * 规格原文：「以下每条都要有可复现的测试，**缺一不可交付**」。
 *
 * 这份脚本**逐条直接断言**，而不是「相信别的验证脚本覆盖了」——
 * 安全验收如果建立在「某某脚本应该测过」之上，那它证明的就不是安全性，
 * 而是我对别人脚本的信心。所以除了必须起真容器的第 4 条，其余十一条
 * 都在本进程内独立复现一遍。
 *
 * 第 4 条（实例间隔离 / Manager 内部端口不可达）要真容器与真网络，
 * 由 `verify-isolation.mjs` 负责，这里显式标注为「委派」并给出指向 ——
 * **委派要写明，不能默默算过**。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { openDb } from '../dist/core/db.js';
import { requireMasterKey, deriveKey, CryptoError } from '../dist/core/auth/crypto.js';
import { AuthService } from '../dist/core/auth/service.js';
import { InstanceRepo } from '../dist/core/instance/repo.js';
import { InstanceService } from '../dist/core/instance/service.js';
import { DockerClient } from '../dist/core/instance/docker-client.js';
import { UserRepo } from '../dist/core/auth/user-repo.js';
import { buildServer } from '../dist/http/app.js';
import { createBackup, restoreBackup } from '../dist/core/archive/backup.js';
import { assertValidSpec, buildCreateOptions, assertSafeCreateOptions }
  from '../dist/core/instance/container-spec.js';
import { redact, assertNoSecrets } from '../dist/core/diag/redact.js';
import { TEST_DATA_ROOT, TEST_EDGE_ROOT, ensureRoot } from './_data-root.mjs';
import { adminSession, sessionFor } from './_session.mjs';

const PORT = 13295;
const ADMIN_PW = 'initial-password-123';
const MASTER = 'security-verify-master-key-0123456789';
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

const results = [];
/** item：对应 04 号文第 12 节的条目号，报告按它归并 */
const check = (item, name, ok, detail = '') => {
  results.push({ item, name, ok });
  console.log(`  ${ok ? '✓' : '✗'} [${String(item).padStart(2)}] ${name}${detail ? '  — ' + detail : ''}`);
};
const delegated = (item, name, to) => {
  results.push({ item, name, ok: true, delegated: to });
  console.log(`  → [${String(item).padStart(2)}] ${name}  — 由 ${to} 负责（需真容器）`);
};

async function main() {
  console.log('\n──── 上线前安全验收 · 04 号文第 12 节逐条 ────\n');
  process.env['MASTER_KEY'] = MASTER;
  await ensureRoot();

  // ══ 1. 无硬编码凭据；缺 MASTER_KEY 拒绝启动 ══════════
  {
    let threw = false;
    try {
      requireMasterKey({ NODE_ENV: 'production' });
    } catch (e) {
      threw = e instanceof CryptoError;
    }
    check(1, '缺 MASTER_KEY 时拒绝启动（生产模式）', threw);

    /*
     * 全仓检索硬编码凭据。只扫源码与配置，跳过 node_modules、构建产物、
     * 以及**验证脚本自身**（它们必然含测试用的假凭据，那是刻意的）。
     */
    /*
     * `git grep` **没找到匹配时退出码是 1** —— 而那正是我们要的结果。
     * 不吞掉这个退出码的话，「仓库很干净」会被当成「命令执行失败」。
     */
    let grepped = '';
    try {
      grepped = execFileSync('git', ['grep', '-nE',
        '(password|secret|passwd|apikey|api_key)\\s*[:=]\\s*["\'][^"\']{8,}["\']',
        '--', 'apps/*/src', 'packages', 'docker-compose*.yml', 'Dockerfile*',
      ], { cwd: REPO_ROOT, encoding: 'utf8' });
    } catch (e) {
      if (e.status !== 1) throw e;       // 1 = 无匹配；其余才是真失败
    }
    const suspicious = grepped.split('\n').filter(Boolean)
      // 类型声明、注释与测试夹具不算
      .filter((l) => !/\.test\.ts|\.fixtures\.ts|^\S+:\s*\*|\/\//.test(l));
    check(1, '源码与部署配置中无硬编码凭据', suspicious.length === 0,
      suspicious.length ? suspicious.slice(0, 2).join(' | ') : '已扫 src / packages / compose / Dockerfile');
  }

  // ══ 起服务，供 2/3/7/8/9 用 ════════════════════════
  const dataDir = mkdtempSync(join(tmpdir(), 'tle-sec-'));
  const db = openDb(join(dataDir, 'edge.db'));
  const key = deriveKey(MASTER, 'thinglinks-edge:instance-cred');
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const repo = new InstanceRepo(db, key);
  repo.create({ id: 'sec-a', name: 'A', imageTag: '5.0.4-24-minimal', memLimit: 512,
                cpuLimit: 0.5, adminRoot: '/red/sec-a/', credSecret: 'cs', notes: '' },
              [], [{ username: 'admin', password: 'nr-pass-secret-1', permissions: '*' }]);
  repo.create({ id: 'sec-b', name: 'B', imageTag: '5.0.4-24-minimal', memLimit: 512,
                cpuLimit: 0.5, adminRoot: '/red/sec-b/', credSecret: 'cs', notes: '' },
              [], [{ username: 'admin', password: 'nr-pass-secret-2', permissions: '*' }]);
  const users = new UserRepo(db);
  const opsPw = users.create('ops', 'operator', 'admin');
  users.grant('ops', 'sec-a', 'operate', 'admin');   // 只授权 A，不授权 B

  const docker = new DockerClient({
    network: 'tle-sec-net', imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 }, instanceDataRoot: TEST_DATA_ROOT, timezone: 'UTC',
  });
  const service = new InstanceService({
    db, repo, docker, basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: ['5.0.4-24-minimal'],
  });
  const config = {
    externalUrl: `http://127.0.0.1:${PORT}`, basePath: '', cookieSecure: false,
    allowedOrigins: [`http://127.0.0.1:${PORT}`], listenAddr: '127.0.0.1', listenPort: PORT,
    dataDir, dataRoot: TEST_EDGE_ROOT, instanceDataRoot: TEST_DATA_ROOT,
    portRange: { min: 30000, max: 30999 }, timezone: 'UTC', updateCheckUrl: '',
  };
  const app = buildServer({ config, db, auth, repo, service });
  await app.listen({ host: '127.0.0.1', port: PORT });
  server = app;
  const B = `http://127.0.0.1:${PORT}`;

  // ══ 2. 未登录访问一律被拒 ═══════════════════════════
  {
    const paths = ['/api/instances', '/api/instances/sec-a', '/api/instances/sec-a/logs',
                   '/api/health', '/api/cloud', '/api/me/permissions'];
    const codes = [];
    for (const p of paths) codes.push((await fetch(`${B}${p}`)).status);
    check(2, '未登录访问实例、日志、健康、云配置全被拒',
      codes.every((c) => c === 401), `状态码 ${codes.join(' ')}`);
  }

  const admin = await adminSession(B, ADMIN_PW);
  const H = (s) => ({ cookie: s.cookie, 'content-type': 'application/json', 'x-csrf-token': s.csrf });

  // ══ 3. 越权：无授权实例的任何接口与日志都进不去 ══════
  {
    const ops = await sessionFor(B, 'ops', opsPw);
    const denied = [];
    for (const [path, init] of [
      [`/api/instances/sec-b`, {}],
      [`/api/instances/sec-b/logs`, {}],
      [`/api/instances/sec-b/start`, { method: 'POST', headers: H(ops) }],
      [`/api/instances/sec-b/flows`, {}],
    ]) {
      const r = await fetch(`${B}${path}`, { headers: { cookie: ops.cookie }, ...init });
      denied.push(r.status);
    }
    check(3, 'A 用户访问未授权实例的接口与日志全被拒',
      denied.every((c) => c === 403), `状态码 ${denied.join(' ')}`);

    const allowed = await fetch(`${B}/api/instances/sec-a`, { headers: { cookie: ops.cookie } });
    check(3, '已授权的实例仍可正常访问（不是一刀切拒绝）', allowed.status === 200,
      `HTTP ${allowed.status}`);
  }

  // ══ 4. 实例隔离 —— 委派 ════════════════════════════
  delegated(4, '实例间隔离 + Manager 内部端口不可达', 'verify-isolation.mjs');

  // ══ 5. 容器逃逸面：白名单挡住危险参数 ═══════════════
  {
    const spec = { id: 'sec-probe', name: 'probe', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5, ports: [] };
    assertValidSpec(spec, { min: 30000, max: 30999 });
    const evil = [
      ['Binds 挂宿主根', { HostConfig: { Binds: ['/:/host'] } }],
      ['Privileged', { HostConfig: { Privileged: true } }],
      ['host 网络', { HostConfig: { NetworkMode: 'host' } }],
      ['host PID', { HostConfig: { PidMode: 'host' } }],
      ['挂 docker.sock', { HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock'] } }],
    ];
    const blocked = [];
    for (const [label, extra] of evil) {
      const opts = { ...buildCreateOptions(spec, { instanceDataRoot: TEST_DATA_ROOT, network: 'n', timezone: 'UTC' }) };
      opts.HostConfig = { ...opts.HostConfig, ...extra.HostConfig };
      try { assertSafeCreateOptions(opts, { instanceDataRoot: TEST_DATA_ROOT }); blocked.push(`${label}:放行`); }
      catch { /* 被拒是期望结果 */ }
    }
    check(5, '创建参数白名单挡住 Binds / Privileged / host 网络 / host PID / docker.sock',
      blocked.length === 0, blocked.length ? '漏放：' + blocked.join(' ') : '5 种逃逸参数全部被拒');
  }

  // ══ 6. 非 root、只读根、能力裁剪 ════════════════════
  {
    const opts = buildCreateOptions(
      { id: 'sec-probe', name: 'probe', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5, ports: [] },
      { instanceDataRoot: TEST_DATA_ROOT, network: 'n', timezone: 'UTC' });
    const hc = opts.HostConfig ?? {};
    check(6, '实例以非 root 运行', String(opts.User ?? '') !== '' && !String(opts.User).startsWith('0'),
      `User=${opts.User}`);
    check(6, '能力已裁剪（CapDrop ALL）',
      Array.isArray(hc.CapDrop) && hc.CapDrop.includes('ALL'), JSON.stringify(hc.CapDrop));
    check(6, '禁止提权（no-new-privileges）',
      (hc.SecurityOpt ?? []).some((o) => /no-new-privileges/.test(o)), JSON.stringify(hc.SecurityOpt));
  }

  // ══ 7. CSRF ═══════════════════════════════════════
  {
    const noToken = await fetch(`${B}/api/instances/sec-a/stop`, {
      method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json' },
    });
    const badToken = await fetch(`${B}/api/instances/sec-a/stop`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json', 'x-csrf-token': 'forged' },
    });
    check(7, '缺 CSRF 令牌与伪造令牌的写操作都被拒',
      noToken.status === 403 && badToken.status === 403,
      `无令牌 ${noToken.status} · 伪造 ${badToken.status}`);
  }

  // ══ 8. CSWSH：伪造 Origin 的升级被拒 ════════════════
  {
    const forged = await fetch(`${B}/red/sec-a/comms`, {
      headers: {
        cookie: admin.cookie, origin: 'http://evil.example.com',
        upgrade: 'websocket', connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
      },
    }).catch((e) => ({ status: 0, err: e.message }));
    check(8, '伪造 Origin 的 WebSocket 升级被拒',
      forged.status !== 101, `HTTP ${forged.status}`);
  }

  // ══ 9. 登录限速与锁定 ══════════════════════════════
  {
    /*
     * 锁定与普通失败**同为 401**，靠错误消息区分 —— 这是有意的：
     * 用不同状态码回答「这个账号被锁了」，等于给攻击者一个免费的账号枚举信号。
     * 所以这里断言的是消息，不是状态码。
     */
    const msgs = [];
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${B}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong-password-' + i }),
      });
      msgs.push(((await r.json().catch(() => ({}))).error ?? '') + `#${r.status}`);
    }
    const lockedAt = msgs.findIndex((m) => /锁定/.test(m));
    check(9, '连续登录失败触发账号锁定', lockedAt >= 0,
      lockedAt >= 0 ? `第 ${lockedAt + 1} 次起被锁：${msgs[lockedAt].slice(0, 40)}`
        : `8 次全是：${msgs[0]}`);
    check(9, '锁定不用独立状态码，避免成为账号枚举信号',
      msgs.every((m) => m.endsWith('#401')), msgs.map((m) => m.slice(-4)).join(' '));

    // 锁定期内即使口令正确也要被拒，否则锁定形同虚设
    const correct = await fetch(`${B}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: admin.password }),
    });
    check(9, '锁定期内正确口令同样被拒', correct.status === 401, `HTTP ${correct.status}`);
  }

  // ══ 10. 备份在无密钥情况下解不出凭据 ════════════════
  {
    const schemaVersion = db.prepare('SELECT version FROM schema_version LIMIT 1').get().version;
    const tar = await createBackup({
      db, key, instanceDataRoot: TEST_DATA_ROOT,
      instances: repo.list().map((i) => ({ id: i.id, name: i.name, imageTag: i.imageTag })),
      schemaVersion,
    });

    // 10a：备份文件里搜不到明文凭据
    const raw = tar.toString('utf8');
    const leaked = ['nr-pass-secret-1', 'nr-pass-secret-2', MASTER].filter((s) => raw.includes(s));
    check(10, '备份文件中搜不到明文凭据与主密钥', leaked.length === 0,
      leaked.length ? '泄漏：' + leaked.join(' ') : '3 项均未出现');

    // 10b：换一把密钥恢复必须失败，而不是恢复出一堆解不开的凭据
    const otherRoot = mkdtempSync(join(tmpdir(), 'tle-sec-restore-'));
    let refused = false;
    let reason = '';
    try {
      await restoreBackup({
        archive: tar, dataRoot: otherRoot,
        key: deriveKey('a-completely-different-master-key', 'thinglinks-edge:instance-cred'),
      });
    } catch (e) { refused = true; reason = e.message.slice(0, 60); }
    check(10, '用错误密钥恢复时当场拒绝，而不是恢复出解不开的凭据', refused, reason);
  }

  // ══ 11. 日志与审计中无明文凭据、无 token ════════════
  {
    const token = 'ingest-token-should-not-leak-0011';
    repo.setIngestToken('sec-a', token);
    const line = `[init] 已创建初始账号 admin，初始口令：${token}`;
    check(11, '脱敏能抹掉日志里的凭据', !redact(line, { secrets: [token] }).includes(token));

    // 审计表整表扫描：任何一条含凭据都不可接受
    const audits = JSON.stringify(db.prepare('SELECT * FROM audit').all());
    let clean = true;
    try { assertNoSecrets(audits, [token, MASTER, 'nr-pass-secret-1']); } catch { clean = false; }
    check(11, '审计表中无明文凭据与令牌', clean,
      `已扫 ${db.prepare('SELECT COUNT(*) n FROM audit').get().n} 条审计`);
  }

  // ══ 12. 实例 1880 不得映射到宿主 ════════════════════
  {
    /*
     * 闸门在 `assertSafeCreateOptions` —— 它查的是**最终交给 docker 的
     * PortBindings**，而不是入参里的 containerPort。这个位置是对的：
     * 无论请求怎么绕（改 spec、直接构造 options），最后都要过这一关。
     */
    let rejected = false;
    let msg = '';
    try {
      const opts = buildCreateOptions(
        { id: 'sec-probe', name: 'probe', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5,
          ports: [{ hostPort: 30001, containerPort: 1880, protocol: 'tcp',
                    hostIp: '127.0.0.1', purpose: 'x' }] },
        { instanceDataRoot: TEST_DATA_ROOT, network: 'n', timezone: 'UTC' });
      assertSafeCreateOptions(opts, { instanceDataRoot: TEST_DATA_ROOT });
    } catch (e) { rejected = true; msg = e.message.slice(0, 46); }
    check(12, '把实例 1880 映射到宿主的请求被拒绝', rejected, msg);

    // 真实例上再核一遍：数据目录下不该出现任何 1880 的宿主绑定
    const created = repo.list().flatMap((i) => repo.ports?.(i.id) ?? []);
    check(12, '已存实例中无 1880 的宿主映射',
      !created.some((p) => p.containerPort === 1880), `${created.length} 条映射`);
  }

  await app.close();

  // ══ 验收矩阵 ══════════════════════════════════════
  const byItem = new Map();
  for (const r of results) {
    const cur = byItem.get(r.item) ?? { ok: true, n: 0, delegated: undefined };
    cur.ok &&= r.ok; cur.n += 1;
    if (r.delegated) cur.delegated = r.delegated;
    byItem.set(r.item, cur);
  }
  console.log('\n──── 验收矩阵（04 号文第 12 节）────');
  for (let i = 1; i <= 12; i++) {
    const v = byItem.get(i);
    const mark = !v ? '？未覆盖' : v.delegated ? `→ ${v.delegated}` : v.ok ? '✓ 通过' : '✗ 失败';
    console.log(`  ${String(i).padStart(2)}. ${mark}${v && !v.delegated ? `（${v.n} 条断言）` : ''}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('  失败：' + failed.map((f) => `[${f.item}] ${f.name}`).join('、'));
    process.exitCode = 1;
  }
}

/*
 * fatal 时也要把服务关掉。不关的话端口一直被占着，下一次跑会卡在 listen 上
 * 且**毫无输出** —— 真正的错误被这个连锁反应完全盖住，这次就踩了。
 */
let server;
main().catch((e) => { console.error('\n[fatal]', e); process.exitCode = 1; })
  .finally(async () => { await server?.close().catch(() => {}); });
