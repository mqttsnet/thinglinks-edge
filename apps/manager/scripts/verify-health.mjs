/**
 * 健康探针端到端验证：三层探针在真实容器上的行为。
 *
 * 重点验证「容器在跑但应用不通」这类分层才能发现的故障 ——
 * 只看容器状态会漏掉「进程还在但已经不干活」。
 */
import bcrypt from 'bcryptjs';
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

const ID = 'health-a';
const NET = 'tle-health-net';
const BRIDGE = 'tle-health-bridge';
const BRIDGE_PORT = 18921;
const PORT = 13301;
const PW = 'initial-password-123';
const TAG = '5.0.4-24-minimal';

const raw = new Docker();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await raw.getContainer(BRIDGE).remove({ force: true }).catch(() => {});
  await raw.getContainer(containerName(ID)).remove({ force: true }).catch(() => {});
  await raw.getVolume(volumeName(ID)).remove({ force: true }).catch(() => {});
  const nets = await raw.listNetworks({ filters: { label: ['com.mqttsnet.thinglinks-edge.managed=true'] } }).catch(() => []);
  for (const n of nets) await raw.getNetwork(n.Id).remove().catch(() => {});
  await raw.getNetwork(NET).remove().catch(() => {});
}

async function main() {
  console.log('\n──── 健康探针 · 真实容器验证 ────\n');
  await cleanup();

  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tle-health-')), 'edge.db'));
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', PW);
  const repo = new InstanceRepo(db, deriveKey('verify', 'salt'));
  const docker = new DockerClient({ network: NET, imageRepo: 'nodered/node-red', portRange: { min: 30000, max: 30999 } });
  const service = new InstanceService({
    db, repo, docker, basePath: '', portRange: { min: 30000, max: 30999 },
    allowedImageTags: [TAG],
    upstreamFor: () => `http://127.0.0.1:${BRIDGE_PORT}`,
  });
  const config = {
    externalUrl: `http://127.0.0.1:${PORT}`, basePath: '', cookieSecure: false,
    allowedOrigins: [`http://127.0.0.1:${PORT}`], listenAddr: '127.0.0.1',
    listenPort: PORT, dataDir: '/tmp', portRange: { min: 30000, max: 30999 },
  };
  const app = buildServer({ config, db, auth, repo, service });
  await app.listen({ host: '127.0.0.1', port: PORT });
  const B = `http://127.0.0.1:${PORT}`;

  const login = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PW }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const csrf = /tle_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  const H = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };

  await fetch(`${B}/api/instances`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: ID, name: '健康验证', imageTag: TAG, memoryMb: 256, cpus: 0.5, portSpec: '' }),
  });

  // 边车让宿主可达实例（实例 1880 不映射宿主）
  await raw.createContainer({
    name: BRIDGE, Image: 'alpine/socat',
    Cmd: [`TCP-LISTEN:${BRIDGE_PORT},fork,reuseaddr`, `TCP:${containerName(ID)}:1880`],
    ExposedPorts: { [`${BRIDGE_PORT}/tcp`]: {} },
    HostConfig: {
      NetworkMode: docker.instanceNetwork(ID),
      PortBindings: { [`${BRIDGE_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(BRIDGE_PORT) }] },
    },
  }).then((c) => c.start());

  // 等 Node-RED 完全就绪
  let h = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    h = (await (await fetch(`${B}/api/instances/${ID}/health`, { headers: { cookie } })).json()).health;
    if (h?.verdict === 'healthy') break;
  }

  check('综合判定为 healthy', h?.verdict === 'healthy', `verdict=${h?.verdict}`);
  check('容器层：运行中且重启次数为 0', h?.container?.running === true && h.container.restartCount === 0);
  check('容器层：CPU 百分比可读且合理', typeof h?.container?.cpuPercent === 'number' && h.container.cpuPercent >= 0,
        `${h?.container?.cpuPercent}%`);
  check('容器层：内存用量在配额内', typeof h?.container?.memUsedMb === 'number' && h.container.memUsedMb <= h.container.memLimitMb,
        `${h?.container?.memUsedMb} / ${h?.container?.memLimitMb} MB`);
  check('应用层：HTTP 探针通且有延迟数据', h?.app?.ok === true && typeof h.app.latencyMs === 'number',
        `HTTP ${h?.app?.status} · ${h?.app?.latencyMs}ms`);
  check('业务层：flow 已启动', h?.flow?.started === true);

  // 关键：停掉应用但保留容器视角 —— 这里直接停容器，验证分层能反映出来
  await fetch(`${B}/api/instances/${ID}/stop`, { method: 'POST', headers: H });
  let down = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    down = (await (await fetch(`${B}/api/instances/${ID}/health`, { headers: { cookie } })).json()).health;
    if (down?.verdict === 'down') break;
  }
  check('停止后综合判定为 down', down?.verdict === 'down', `state=${down?.container?.state}`);
  check('停止后应用层给出未运行原因', down?.app?.ok === false, down?.app?.error ?? '');

  // 汇总接口
  const all = await (await fetch(`${B}/api/health`, { headers: { cookie } })).json();
  check('汇总接口给出分类计数', all?.summary?.total === 1 && all.summary.down === 1,
        JSON.stringify(all?.summary));
  check('宿主资源可读', typeof all?.host?.memPercent === 'number' && all.host.cpuCount > 0,
        `CPU ${all?.host?.cpuCount} 核 · 内存 ${all?.host?.memPercent}% · 磁盘 ${all?.host?.diskPercent}%`);

  const anon = await fetch(`${B}/api/health`);
  check('未登录访问健康接口被拒绝', anon.status === 401);

  await app.close();
  await cleanup();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (e) => { console.error('\n验证失败：', e.message); await cleanup(); process.exit(1); });
