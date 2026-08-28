/**
 * 实例间网络隔离验证。
 *
 * 背景：Node-RED 的 Function 节点等于容器内 RCE（Node 官方明确 vm 不是安全机制）。
 * 若实例共处一个网络，实例 A 的 Function 节点可直接 fetch 实例 B 的 1880，
 * 绕过 Manager 的全部鉴权 —— 这是设计级漏洞，必须在真实环境验证而非假设。
 *
 * 用法： node scripts/verify-isolation.mjs
 */
import bcrypt from 'bcryptjs';
import Docker from 'dockerode';
import { DockerClient } from '../dist/core/instance/docker-client.js';
import { renderSettings } from '../dist/core/instance/settings-template.js';
import { adminRootFor } from '../dist/core/config.js';
import { containerName } from '../dist/core/instance/container-spec.js';
import { TEST_DATA_ROOT, ensureRoot, resetDataDir } from './_data-root.mjs';

const A = 'iso-a';
const B = 'iso-b';
const NET = 'tle-iso-net';
const raw = new Docker();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在容器内执行 node 脚本并取回输出 */
async function execIn(name, script) {
  const ex = await raw.getContainer(name).exec({
    Cmd: ['node', '-e', script], AttachStdout: true, AttachStderr: true,
  });
  const stream = await ex.start({ hijack: true });
  let out = '';
  await new Promise((resolve) => {
    stream.on('data', (d) => { out += d.toString('utf8'); });
    stream.on('end', resolve);
    setTimeout(resolve, 12000);
  });
  return out.replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

async function cleanup() {
  for (const id of [A, B]) {
    await raw.getContainer(containerName(id)).remove({ force: true }).catch(() => {});
    await resetDataDir(id);
  }
  for (const n of [NET, `${NET}-${A}`, `${NET}-${B}`]) {
    await raw.getNetwork(n).remove().catch(() => {});
  }
  // 清掉可能残留的实例网络
  const nets = await raw.listNetworks({ filters: { label: ['com.mqttsnet.thinglinks-edge.managed=true'] } });
  for (const n of nets) await raw.getNetwork(n.Id).remove().catch(() => {});
}

async function createAndStart(client, id) {
  const adminRoot = adminRootFor('', id);
  await client.createInstance(
    { id, imageTag: '5.0.4-24-minimal', memoryMb: 256, cpus: 0.5, ports: [], adminRoot },
    renderSettings({
      instanceId: id, adminRoot, credentialSecret: 'cs',
      credentials: [{ username: 'admin', passwordHash: bcrypt.hashSync('secret', 8), permissions: '*' }],
    }),
  );
  await client.start(id);
}

async function main() {
  console.log('\n──── 实例间网络隔离 · 真实容器验证 ────\n');
  await ensureRoot();
  await cleanup();

  const client = new DockerClient({
    network: NET, imageRepo: 'nodered/node-red', portRange: { min: 30000, max: 30999 },
    instanceDataRoot: TEST_DATA_ROOT, timezone: 'Asia/Shanghai',
  });

  await createAndStart(client, A);
  await createAndStart(client, B);

  for (const id of [A, B]) {
    let ready = false;
    for (let i = 0; i < 45 && !ready; i++) {
      await sleep(1000);
      ready = (await client.logs(id, 40)).includes('Server now running at');
    }
    check(`实例 ${id} 就绪`, ready);
    if (!ready) throw new Error(`${id} 未就绪`);
  }

  // 核心断言：从 A 内部尝试访问 B 的 1880
  const probe = `
    const t = setTimeout(() => { console.log('RESULT:TIMEOUT'); process.exit(0); }, 6000);
    fetch('http://${containerName(B)}:1880/red/${B}/')
      .then(r => { clearTimeout(t); console.log('RESULT:REACHABLE:' + r.status); })
      .catch(e => { clearTimeout(t); console.log('RESULT:BLOCKED:' + (e.cause?.code || e.message)); });
  `;
  const out = await execIn(containerName(A), probe);
  const reachable = out.includes('RESULT:REACHABLE');
  const verdict = (out.match(/RESULT:[A-Z]+(:[^\s]*)?/) ?? ['(无输出)'])[0];

  check('实例 A 无法访问实例 B 的 1880', !reachable, verdict);

  // 反向再验一次，排除偶然
  const outRev = await execIn(containerName(B), probe.replace(containerName(B), containerName(A)).replace(`/red/${B}/`, `/red/${A}/`));
  check('实例 B 无法访问实例 A 的 1880', !outRev.includes('RESULT:REACHABLE'),
        (outRev.match(/RESULT:[A-Z]+(:[^\s]*)?/) ?? ['(无输出)'])[0]);

  // 网络归属检查
  const infoA = await raw.getContainer(containerName(A)).inspect();
  const infoB = await raw.getContainer(containerName(B)).inspect();
  const netsA = Object.keys(infoA.NetworkSettings.Networks);
  const netsB = Object.keys(infoB.NetworkSettings.Networks);
  const shared = netsA.filter((n) => netsB.includes(n));
  check('两实例不共处任何网络', shared.length === 0,
        `A=[${netsA.join(',')}] B=[${netsB.join(',')}]`);

  await cleanup();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (e) => { console.error('\n验证失败：', e.message); await cleanup(); process.exit(1); });
