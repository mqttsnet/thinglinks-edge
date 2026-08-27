/**
 * 端到端验证：Manager 反代 + 免密跳转 + WebSocket，对接真实 Node-RED 容器。
 *
 * 实例容器保持生产配置原样（1880 不映射宿主），
 * 由一个显式的 socat 边车容器为宿主测试搭桥 —— 这是测试脚手架，不改变生产拓扑。
 *
 * 用法： node scripts/verify-proxy.mjs [basePath]
 */
import bcrypt from 'bcryptjs';
import Docker from 'dockerode';
import WebSocket from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DockerClient } from '../dist/core/docker-client.js';
import { renderSettings } from '../dist/core/settings-template.js';
import { adminRootFor, authTokenKeyFor } from '../dist/core/config.js';
import { containerName } from '../dist/core/container-spec.js';
import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/crypto.js';
import { AuthService } from '../dist/core/auth.js';
import { InstanceRepo } from '../dist/core/instance-repo.js';
import { buildServer } from '../dist/http/app.js';
import { TEST_DATA_ROOT, ensureRoot, resetDataDir } from './_data-root.mjs';

const BASE_PATH = process.argv[2] ?? '';
const ID = 'proxy-a';
const NET = 'tle-verify-net';
const BRIDGE = 'tle-verify-bridge';
const BRIDGE_PORT = 18901;
const MGR_PORT = 13101;
const ADMIN_PW = 'initial-password-123';
const NR_PW = 'nr-secret';

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
  await resetDataDir(ID);
  await raw.getNetwork(NET).remove().catch(() => {});
  const nets = await raw.listNetworks({ filters: { label: ['com.mqttsnet.thinglinks-edge.managed=true'] } }).catch(() => []);
  for (const n of nets) await raw.getNetwork(n.Id).remove().catch(() => {});
}

async function main() {
  console.log(`\n──── 反代端到端验证（basePath=${BASE_PATH || '(根路径)'}）────\n`);
  await ensureRoot();
  await cleanup();

  const adminRoot = adminRootFor(BASE_PATH, ID);
  const client = new DockerClient({
    network: NET, imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 }, instanceDataRoot: TEST_DATA_ROOT, timezone: 'Asia/Shanghai',
  });

  await client.createInstance({
    id: ID, imageTag: '5.0.4-24-minimal', memoryMb: 256, cpus: 0.5, ports: [], adminRoot,
  }, renderSettings({
    instanceId: ID, adminRoot, credentialSecret: 'cs',
    credentials: [{ username: 'admin', passwordHash: bcrypt.hashSync(NR_PW, 8), permissions: '*' }],
  }));
  await client.start(ID);

  let ready = false;
  for (let i = 0; i < 45 && !ready; i++) {
    await sleep(1000);
    ready = (await client.logs(ID, 50)).includes('Server now running at');
  }
  check('真实 Node-RED 实例就绪', ready);
  if (!ready) throw new Error('实例未就绪');

  // 测试脚手架：实例 1880 不映射宿主，用边车转发给宿主测试
  const instNet = client.instanceNetwork(ID);
  await raw.createContainer({
    name: BRIDGE, Image: 'alpine/socat',
    Cmd: [`TCP-LISTEN:${BRIDGE_PORT},fork,reuseaddr`, `TCP:${containerName(ID)}:1880`],
    ExposedPorts: { [`${BRIDGE_PORT}/tcp`]: {} },
    HostConfig: {
      NetworkMode: instNet,
      PortBindings: { [`${BRIDGE_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(BRIDGE_PORT) }] },
    },
  }).then((c) => c.start());
  await sleep(1500);

  // Manager：注入宿主可达的上游（生产默认按容器名解析）
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tle-verify-')), 'edge.db'));
  const key = deriveKey('verify-master', 'salt');
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const repo = new InstanceRepo(db, key);
  repo.create(
    { id: ID, name: '验证实例', imageTag: '5.0.4-24-minimal', memLimit: 256, cpuLimit: 0.5, adminRoot, credSecret: 'cs', notes: '' },
    [],
    [{ username: 'admin', password: NR_PW, permissions: '*' }],
  );

  const config = {
    externalUrl: `http://127.0.0.1:${MGR_PORT}${BASE_PATH}`,
    basePath: BASE_PATH, cookieSecure: false,
    allowedOrigins: [`http://127.0.0.1:${MGR_PORT}`],
    listenAddr: '127.0.0.1', listenPort: MGR_PORT, dataDir: '/tmp',
    portRange: { min: 30000, max: 30999 },
  };
  const app = buildServer({ config, db, auth, repo, upstreamFor: () => `http://127.0.0.1:${BRIDGE_PORT}` });
  await app.listen({ host: '127.0.0.1', port: MGR_PORT });

  const B = `http://127.0.0.1:${MGR_PORT}${BASE_PATH}`;

  // 1. 未登录被拒
  check('未登录访问实例被拒绝', (await fetch(`${B}/red/${ID}/`, { redirect: 'manual' })).status === 401);

  // 2. 登录
  const login = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PW }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(',').map((c) => c.split(';')[0].trim()).join('; ');
  check('管理面登录成功', login.status === 200 && cookie.includes('tle_sid'));

  // 3. 编辑器
  const editor = await fetch(`${B}/red/${ID}/`, { headers: { cookie } });
  const html = await editor.text();
  check('真实编辑器 HTML 可加载', editor.status === 200 && html.includes('red/red.min.js'), `HTTP ${editor.status}`);

  // 4. 静态资源（真实 Node-RED 用相对路径，按文档 URL 解析）
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !u.startsWith('http') && /\.(js|css)/.test(u)).slice(0, 6);
  const fails = [];
  for (const rel of refs) {
    const abs = new URL(rel, `${B}/red/${ID}/`).toString();
    const r = await fetch(abs, { headers: { cookie } });
    if (r.status !== 200) fails.push(`${rel}→${r.status}`);
  }
  check(`静态资源可取回（抽查 ${refs.length} 个）`, fails.length === 0, fails.join(',') || refs.map((r) => r.split('?')[0]).join(', '));

  // 5. 无尾斜杠 301
  const noSlash = await fetch(`${B}/red/${ID}`, { headers: { cookie }, redirect: 'manual' });
  check('无尾斜杠被 301 重定向', noSlash.status >= 300 && noSlash.status < 400,
        `HTTP ${noSlash.status} → ${noSlash.headers.get('location') ?? ''}`);

  // 6. WebSocket
  const wsUrl = `ws://127.0.0.1:${MGR_PORT}${BASE_PATH}/red/${ID}/comms`;
  const wsOk = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { cookie, origin: `http://127.0.0.1:${MGR_PORT}` } });
    const t = setTimeout(() => { ws.terminate(); resolve(false); }, 6000);
    ws.on('open', () => { clearTimeout(t); ws.close(); resolve(true); });
    ws.on('error', () => { clearTimeout(t); resolve(false); });
  });
  check('真实 /comms WebSocket 握手成功', wsOk);

  // 7. 未鉴权 WebSocket 必须被拒
  const wsNoAuth = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { ws.terminate(); resolve('超时'); }, 5000);
    ws.on('open', () => { clearTimeout(t); ws.close(); resolve('竟然连上'); });
    ws.on('error', (e) => { clearTimeout(t); resolve(e.message); });
  });
  check('未鉴权 WebSocket 被拒绝', wsNoAuth !== '竟然连上', String(wsNoAuth).slice(0, 46));

  // 8. 伪造 Origin 必须被拒（CSWSH）
  const wsBadOrigin = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { cookie, origin: 'http://evil.example.com' } });
    const t = setTimeout(() => { ws.terminate(); resolve('超时'); }, 5000);
    ws.on('open', () => { clearTimeout(t); ws.close(); resolve('竟然连上'); });
    ws.on('error', (e) => { clearTimeout(t); resolve(e.message); });
  });
  check('伪造 Origin 的 WebSocket 被拒绝', wsBadOrigin !== '竟然连上', String(wsBadOrigin).slice(0, 46));

  // 9. 免密跳转
  const sso = await fetch(`${B}/red/${ID}/sso`, { headers: { cookie } });
  const ssoHtml = await sso.text();
  const token = (ssoHtml.match(/\\?"access_token\\?":\\?"([^"\\]+)/) ?? [])[1];
  check('免密跳转取得真实 access_token', sso.status === 200 && Boolean(token), token ? token.slice(0, 14) + '…' : `HTTP ${sso.status}`);

  // 10. 存储键必须按 httpAdminRoot 命名空间化
  const expectKey = authTokenKeyFor(adminRoot);
  check('token 存储键按 httpAdminRoot 命名空间化', ssoHtml.includes(`"${expectKey}"`), expectKey);

  // 11. token 可调真实 admin API
  const api = await fetch(`${B}/red/${ID}/flows`, { headers: { cookie, authorization: `Bearer ${token}` } });
  check('用该 token 调真实 admin API /flows', api.status === 200, `HTTP ${api.status}`);

  // 12. 无 token 时实例自身拒绝（纵深防御）
  const bare = await fetch(`${B}/red/${ID}/flows`, { headers: { cookie } });
  check('无 token 调 admin API 被实例自身拒绝', bare.status === 401, `HTTP ${bare.status}（实例侧 adminAuth 生效）`);

  await app.close();
  await cleanup();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n验证失败：', e.message);
  await cleanup();
  process.exit(1);
});
