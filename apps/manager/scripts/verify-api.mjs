/**
 * 实例 CRUD API 端到端验证，对着真实 Docker 跑完整生命周期。
 *
 * 每步都回到 Docker 核对真实状态，不只看 API 返回码 ——
 * API 说成功但容器没起来，是最容易漏掉的一类问题。
 */
import Docker from 'dockerode';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/crypto.js';
import { AuthService } from '../dist/core/auth.js';
import { InstanceRepo } from '../dist/core/instance-repo.js';
import { InstanceService } from '../dist/core/instance-service.js';
import { DockerClient } from '../dist/core/docker-client.js';
import { buildServer } from '../dist/server.js';
import { containerName, volumeName } from '../dist/core/container-spec.js';

const NET = 'tle-api-net';
const PORT = 13202;
const ADMIN_PW = 'initial-password-123';
const ID = 'api-a';
const ID2 = 'api-b';
const TAG = '5.0.4-24-minimal';

const raw = new Docker();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const containerState = async (id) =>
  raw.getContainer(containerName(id)).inspect().then((i) => i.State.Status).catch(() => 'missing');
const volumeExists = async (id) =>
  raw.getVolume(volumeName(id)).inspect().then(() => true).catch(() => false);

async function cleanup() {
  for (const id of [ID, ID2]) {
    await raw.getContainer(containerName(id)).remove({ force: true }).catch(() => {});
    await raw.getVolume(volumeName(id)).remove({ force: true }).catch(() => {});
  }
  await raw.getNetwork(NET).remove().catch(() => {});
}

async function main() {
  console.log('\n──── 实例 CRUD API · 真实 Docker 验证 ────\n');
  await cleanup();

  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tle-api-')), 'edge.db'));
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const repo = new InstanceRepo(db, deriveKey('verify', 'salt'));
  const docker = new DockerClient({ network: NET, imageRepo: 'nodered/node-red', portRange: { min: 30000, max: 30999 } });
  const service = new InstanceService({
    db, repo, docker, basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: [TAG],
  });
  const config = {
    externalUrl: `http://127.0.0.1:${PORT}`, basePath: '', cookieSecure: false,
    allowedOrigins: [`http://127.0.0.1:${PORT}`], listenAddr: '127.0.0.1',
    listenPort: PORT, dataDir: '/tmp', portRange: { min: 30000, max: 30999 },
  };
  const app = buildServer({ config, db, auth, repo, service });
  await app.listen({ host: '127.0.0.1', port: PORT });
  const B = `http://127.0.0.1:${PORT}`;

  // 登录并取 CSRF 令牌
  const login = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PW }),
  });
  const setCookies = login.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  const csrf = /tle_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  check('登录并下发 CSRF 令牌', login.status === 200 && Boolean(csrf));

  const H = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };

  // 端口推荐
  const rec = await (await fetch(`${B}/api/ports/recommend?count=2`, { headers: { cookie } })).json();
  check('端口推荐可用', /^\d+-\d+$/.test(rec.recommended), rec.recommended);

  // 缺 CSRF 必须被拒
  const noCsrf = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ id: ID, name: 'x', imageTag: TAG, portSpec: '' }),
  });
  check('缺少 CSRF 令牌的写操作被拒绝', noCsrf.status === 403, `HTTP ${noCsrf.status}`);

  // 白名单外镜像被拒
  const badImg = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: ID, name: 'x', imageTag: 'latest', portSpec: '' }),
  });
  check('白名单外的镜像 tag 被拒绝', badImg.status === 400, (await badImg.json()).error?.slice(0, 40));

  // 创建实例
  const created = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: ID, name: '一号产线', imageTag: TAG, memoryMb: 256, cpus: 0.5,
                           portSpec: rec.recommended, containerPort: 1883, purpose: 'MQTT' }),
  });
  check('创建实例返回 201', created.status === 201, `HTTP ${created.status}`);

  let state = 'missing';
  for (let i = 0; i < 30 && state !== 'running'; i++) { await sleep(1000); state = await containerState(ID); }
  check('Docker 中容器确实在运行', state === 'running', `state=${state}`);
  check('数据卷已创建', await volumeExists(ID));

  // 列表反映真实状态
  const list = await (await fetch(`${B}/api/instances`, { headers: { cookie } })).json();
  const item = list.instances.find((i) => i.id === ID);
  check('列表反映真实运行状态', item?.running === true, `state=${item?.state}`);
  check('端口按段绑定并顺序对应容器端口',
        item?.ports?.length === 2 && item.ports[1].containerPort === item.ports[0].containerPort + 1,
        JSON.stringify(item?.ports?.map((p) => `${p.hostPort}→${p.containerPort}`)));

  // 端口冲突
  const conflict = await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: ID2, name: '二号', imageTag: TAG, portSpec: String(item.ports[0].hostPort) }),
  });
  const conflictMsg = (await conflict.json()).error ?? '';
  check('端口冲突被拒且指出占用方', conflict.status === 400 && conflictMsg.includes(ID), conflictMsg.slice(0, 46));
  check('冲突后未残留半条记录', (await containerState(ID2)) === 'missing');

  // 停止 / 启动
  const stopRes = await fetch(`${B}/api/instances/${ID}/stop`, { method: 'POST', headers: H });
  if (stopRes.status >= 400) console.log('    [debug] stop ->', stopRes.status, await stopRes.text());
  let stopped = 'x';
  for (let i = 0; i < 20 && stopped !== 'exited'; i++) { await sleep(500); stopped = await containerState(ID); }
  check('停止后容器进入 exited', stopped === 'exited', `state=${stopped}`);

  await fetch(`${B}/api/instances/${ID}/start`, { method: 'POST', headers: H });
  let restarted = 'x';
  for (let i = 0; i < 20 && restarted !== 'running'; i++) { await sleep(500); restarted = await containerState(ID); }
  check('启动后容器回到 running', restarted === 'running', `state=${restarted}`);

  // 日志
  // 容器刚重启，Node-RED 需要几秒才打印就绪行 —— 轮询而非一次性断言
  let logs = '';
  for (let i = 0; i < 30 && !logs.includes('Server now running at'); i++) {
    await sleep(1000);
    logs = await (await fetch(`${B}/api/instances/${ID}/logs?tail=80`, { headers: { cookie } })).text();
  }
  check('可读取实例日志', logs.includes('Server now running at'),
        logs.split('\n').find((l) => l.includes('running at'))?.trim().slice(-40));

  // 重置口令
  const reset = await fetch(`${B}/api/instances/${ID}/credentials/admin/reset`, { method: 'POST', headers: H });
  const resetBody = await reset.text();
  if (reset.status >= 400) console.log('    [debug] reset ->', reset.status, resetBody);
  const newPw = (() => { try { return JSON.parse(resetBody).password; } catch { return undefined; } })();
  check('重置口令返回新口令且仅此一次', reset.status === 200 && typeof newPw === 'string' && newPw.length >= 20);

  let back = 'x';
  for (let i = 0; i < 40 && back !== 'running'; i++) { await sleep(1000); back = await containerState(ID); }
  check('重置后实例重启并恢复运行', back === 'running', `state=${back}`);

  // 未登录访问 API
  const anon = await fetch(`${B}/api/instances`);
  check('未登录访问 API 被拒绝', anon.status === 401);

  // 删除：默认保留数据卷
  const delRes = await fetch(`${B}/api/instances/${ID}`, { method: 'DELETE', headers: H });
  if (delRes.status >= 400) console.log('    [debug] delete ->', delRes.status, await delRes.text());
  check('删除后容器已移除', (await containerState(ID)) === 'missing');
  check('默认保留数据卷（不默认删数据）', await volumeExists(ID));

  await raw.getVolume(volumeName(ID)).remove({ force: true }).catch(() => {});

  await app.close();
  await cleanup();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (e) => { console.error('\n验证失败：', e.message, e.stack); await cleanup(); process.exit(1); });
