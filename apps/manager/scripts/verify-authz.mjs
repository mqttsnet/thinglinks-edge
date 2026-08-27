/**
 * 越权用例 —— 检查点 4 的核心（T4.4）。
 *
 * 这份脚本只做一件事：**逐条尝试越权，确认全部被拒**。
 *
 * 不用真容器：授权判定发生在 HTTP 层，与 Docker 无关；
 * 反代那条链路用一个假上游即可验证「够不够得到」，而不需要真的跑起 Node-RED。
 * 这样它能在几秒内跑完，值得在每次改路由后都跑一遍。
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/crypto.js';
import { AuthService } from '../dist/core/auth.js';
import { InstanceRepo } from '../dist/core/instance-repo.js';
import { UserRepo } from '../dist/core/user-repo.js';
import { InstanceService } from '../dist/core/instance-service.js';
import { MetricsHistory } from '../dist/core/metrics-history.js';
import { FieldRegistry } from '../dist/core/edge/registry.js';
import { buildServer } from '../dist/http/app.js';
import WebSocket from 'ws';

const PORT = 13260;
const B = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = 'initial-password-123';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

/** 假 Docker：授权判定不依赖它，这里只要不炸 */
const fakeDocker = {
  async ensureNetwork() {}, async ensureDataDir() {}, async createInstance() {},
  async start() {}, async stop() {}, async restart() {}, async remove() {},
  async assertManaged() {}, async logs() { return ''; },
  async list() { return []; },
  containerRef() { return { async inspect() { return { State: { Status: 'running', Running: true } }; },
                            async stats() { return {}; } }; },
};

async function login(username, password) {
  const res = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) return undefined;
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const csrf = /tle_csrf=([^;]+)/.exec(cookie)?.[1];
  return { cookie, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' } };
}

const status = async (path, sess, init = {}) =>
  (await fetch(`${B}${path}`, { ...init, headers: { ...(sess?.headers ?? {}), ...(init.headers ?? {}) } })).status;

async function main() {
  console.log('\n──── 越权用例 · 全拒验证 ────\n');

  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tle-authz-')), 'edge.db'));
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const repo = new InstanceRepo(db, deriveKey('authz', 'salt'));
  const users = new UserRepo(db);
  const service = new InstanceService({
    db, repo, docker: fakeDocker, basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: ['5.0.4-24-minimal'],
  });

  // 两台实例直接落库，绕开 Docker
  for (const id of ['line-a', 'line-b']) {
    repo.create(
      { id, name: id, imageTag: '5.0.4-24-minimal', memLimit: 512, cpuLimit: 0.5,
        adminRoot: `/red/${id}/`, credSecret: 'cs', notes: '' },
      [], [{ username: 'admin', password: 'pw', permissions: '*' }],
    );
  }

  /*
   * 台账与趋势里都塞两台实例的数据。
   * 这两类是**聚合**接口（一次返回全部实例），guard 按实例拦不住，
   * 只能靠逐条过滤 —— 所以必须有 line-b 的数据在里面才测得出漏没漏。
   */
  const registry = new FieldRegistry(db);
  registry.upsertDevice('line-a', { nodeId: 'n-a', name: 'A 线泵', protocol: 'modbus', address: '10.0.1.5:502' });
  registry.upsertDevice('line-b', { nodeId: 'n-b', name: 'B 线炉', protocol: 'modbus', address: '10.0.2.7:502' });

  const metrics = new MetricsHistory({ fineStepSec: 10 });
  const inst = (cpu) => ({ cpuPercent: cpu, memUsedMb: 64, memPercent: 12, latencyMs: 5, verdict: 'healthy' });
  metrics.record({
    t: Date.now(),
    host: { loadPercent: 10, memPercent: 50, diskPercent: 30 },
    instances: { 'line-a': inst(1), 'line-b': inst(9) },
  });

  // 假上游：反代若放行就会打到它；被拒时它一次都不会被访问到
  let upstreamHits = 0;
  const upstream = createServer((_q, s) => { upstreamHits += 1; s.end('UPSTREAM'); });
  await new Promise((r) => upstream.listen(13261, '127.0.0.1', r));

  const app = buildServer({
    config: {
      externalUrl: B, basePath: '', cookieSecure: false, allowedOrigins: [B],
      listenAddr: '127.0.0.1', listenPort: PORT, dataDir: '/tmp',
      dataRoot: '/tmp', instanceDataRoot: '/tmp', portRange: { min: 30000, max: 30999 },
    },
    db, auth, repo, service, metrics,
    upstreamFor: () => 'http://127.0.0.1:13261',
  });
  await app.listen({ host: '127.0.0.1', port: PORT });

  // ── 准备账号 ──
  const admin = await login('admin', ADMIN_PW);
  await fetch(`${B}/api/change-password`, {
    method: 'POST', headers: admin.headers,
    body: JSON.stringify({ oldPassword: ADMIN_PW, newPassword: 'admin-pass-1234' }),
  });
  const root = await login('admin', 'admin-pass-1234');
  check('管理员登录并完成首次改密', Boolean(root));

  const mk = async (username, role) => {
    const res = await fetch(`${B}/api/users`, {
      method: 'POST', headers: root.headers, body: JSON.stringify({ username, role }),
    });
    return (await res.json()).password;
  };
  const opPw = await mk('lineop', 'operator');
  const viPw = await mk('watcher', 'viewer');
  check('管理员可新建用户并拿到一次性口令', typeof opPw === 'string' && opPw.length >= 20);

  // 只授权 line-a
  await fetch(`${B}/api/users/lineop/grants`, {
    method: 'POST', headers: root.headers,
    body: JSON.stringify({ instanceId: 'line-a', level: 'operate' }),
  });
  await fetch(`${B}/api/users/watcher/grants`, {
    method: 'POST', headers: root.headers,
    body: JSON.stringify({ instanceId: 'line-a', level: 'view' }),
  });

  // 新用户首次登录要改密，改完再用
  const useAs = async (username, initial, next) => {
    const s0 = await login(username, initial);
    await fetch(`${B}/api/change-password`, {
      method: 'POST', headers: s0.headers,
      body: JSON.stringify({ oldPassword: initial, newPassword: next }),
    });
    return login(username, next);
  };
  const op = await useAs('lineop', opPw, 'operator-pass-1234');
  const vi = await useAs('watcher', viPw, 'viewer-pass-12345');
  check('新建的用户可登录（首次强制改密后）', Boolean(op) && Boolean(vi));

  // ── 运维：授权范围内可用 ──
  const opList = await (await fetch(`${B}/api/instances`, { headers: op.headers })).json();
  check('运维只看得见被授权的实例',
        opList.instances?.length === 1 && opList.instances[0].id === 'line-a',
        (opList.instances ?? []).map((i) => i.id).join(' ') || '空');

  check('运维可查看授权实例', await status('/api/instances/line-a', op) === 200);
  check('运维可启停授权实例',
        await status('/api/instances/line-a/stop', op, { method: 'POST' }) === 204);

  // ── 越权：跨实例 ──
  check('越权·查看未授权实例被拒', await status('/api/instances/line-b', op) === 403);
  check('越权·启停未授权实例被拒',
        await status('/api/instances/line-b/stop', op, { method: 'POST' }) === 403);
  check('越权·读未授权实例日志被拒', await status('/api/instances/line-b/logs', op) === 403);
  check('越权·看未授权实例健康被拒', await status('/api/instances/line-b/health', op) === 403);

  // ── 越权：反代与免密跳转（最大的越权面）──
  upstreamHits = 0;
  check('越权·反代打开未授权实例编辑器被拒',
        await status('/red/line-b/', op) === 403);
  check('越权·免密跳转未授权实例被拒', await status('/red/line-b/sso', op) === 403);
  check('被拒时请求根本没打到上游', upstreamHits === 0, `上游被访问 ${upstreamHits} 次`);
  check('授权实例的反代仍然可用', await status('/red/line-a/', op) === 200);

  // ── 越权：角色级动作 ──
  check('越权·运维建实例被拒',
        await status('/api/instances', op, { method: 'POST', body: '{}' }) === 403);
  check('越权·运维删实例被拒',
        await status('/api/instances/line-a', op, { method: 'DELETE' }) === 403);
  check('越权·运维管用户被拒', await status('/api/users', op) === 403);
  check('越权·运维跑备份被拒（备份含全部实例凭据）',
        await status('/api/backup', op, { method: 'POST' }) === 403);

  // ── 只读角色 ──
  check('只读可查看授权实例', await status('/api/instances/line-a', vi) === 200);
  check('越权·只读启停被拒',
        await status('/api/instances/line-a/stop', vi, { method: 'POST' }) === 403);
  check('越权·只读重置实例口令被拒',
        await status('/api/instances/line-a/credentials/admin/reset', vi, { method: 'POST' }) === 403);
  check('越权·只读手动补传被拒',
        await status('/api/edge/replay', vi, { method: 'POST' }) === 403);

  // ── 越权：聚合类接口 ──
  // 这类接口天然没有「某一台实例」可判，漏了过滤就是把别人的实例名连同读数端出去
  const trend = await (await fetch(`${B}/api/metrics?range=1h`, { headers: op.headers })).json();
  const trendIds = Object.keys(trend.points?.[0]?.instances ?? {});
  check('越权·趋势曲线不含未授权实例', trend.instanceIds?.length === 1
        && trend.instanceIds[0] === 'line-a' && trendIds.join() === 'line-a',
        `ids=${(trend.instanceIds ?? []).join(' ')} points=${trendIds.join(' ')}`);
  check('趋势里的宿主读数照常返回（整机指标与实例授权无关）',
        typeof trend.points?.[0]?.host?.memPercent === 'number');

  const devs = await (await fetch(`${B}/api/field/devices`, { headers: op.headers })).json();
  check('越权·设备台账聚合查询只含授权实例',
        devs.devices?.length === 1 && devs.devices[0].instanceId === 'line-a',
        (devs.devices ?? []).map((d) => d.instanceId).join(' ') || '空');
  check('越权·指名查未授权实例的台账被拒',
        await status('/api/field/devices?instanceId=line-b', op) === 403);
  check('越权·指名查未授权实例的点位被拒',
        await status('/api/field/tags?instanceId=line-b', op) === 403);
  check('越权·南向探测未授权实例被拒（读的是 flows.json，含设备 IP 与寄存器地址）',
        await status('/api/field/southbound?instanceId=line-b', op) === 403);
  check('越权·未授权实例的台账汇总被拒',
        await status('/api/field/summary?instanceId=line-b', op) === 403);

  // ── 只读授权不是「能看的操作员」──
  upstreamHits = 0;
  check('只读授权可以打开编辑器查看', await status('/red/line-a/', vi) === 200);
  check('越权·只读授权经反代改流程被拒（POST /flows 是部署）',
        await status('/red/line-a/flows', vi, { method: 'POST', body: '[]' }) === 403);
  check('只读被拒时改动没有打到实例', upstreamHits === 1, `上游被访问 ${upstreamHits} 次（应只有那次 GET）`);

  // ── 越权：WebSocket 升级 ──
  // 浏览器不对 WS 施加同源策略，这条链路必须自己判权，且要在升级阶段就拒
  const wsCode = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/red/line-b/comms`,
                             { headers: { cookie: op.cookie, origin: B } });
    const done = (v) => { try { ws.terminate(); } catch { /* 已关 */ } resolve(v); };
    ws.on('unexpected-response', (_q, res) => done(res.statusCode));
    ws.on('open', () => done(101));
    ws.on('error', () => done(0));
    setTimeout(() => done(-1), 3000);
  });
  check('越权·未授权实例的 WebSocket 升级被拒', wsCode === 403, `升级返回 ${wsCode}`);

  // ── 撤销授权立即生效 ──
  await fetch(`${B}/api/users/lineop/grants/line-a`, { method: 'DELETE', headers: root.headers });
  check('撤销授权后立即失效，无需重新登录',
        await status('/api/instances/line-a', op) === 403);

  // ── 停用账号 ──
  await fetch(`${B}/api/users/watcher/disabled`, {
    method: 'POST', headers: root.headers, body: JSON.stringify({ disabled: true }),
  });
  check('停用后已有会话立即失效', await status('/api/instances', vi) === 401);
  check('停用后无法重新登录', (await login('watcher', 'viewer-pass-12345')) === undefined);

  // ── 不能把自己锁在门外 ──
  const selfDisable = await fetch(`${B}/api/users/admin/disabled`, {
    method: 'POST', headers: root.headers, body: JSON.stringify({ disabled: true }),
  });
  check('最后一个管理员不能被停用', selfDisable.status === 400,
        `HTTP ${selfDisable.status} ${(await selfDisable.json()).error ?? ''}`.slice(0, 60));
  const selfDemote = await fetch(`${B}/api/users/admin/role`, {
    method: 'POST', headers: root.headers, body: JSON.stringify({ role: 'viewer' }),
  });
  check('最后一个管理员不能被降级', selfDemote.status === 400);

  // ── 未登录 ──
  check('未登录访问实例被拒', await status('/api/instances') === 401);
  check('未登录访问反代被拒', await status('/red/line-a/') === 401);

  await app.close();
  upstream.close();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  if (pass !== results.length) process.exit(1);
}

main().catch((e) => { console.error('\n  验证异常：', e.message); process.exit(1); });
