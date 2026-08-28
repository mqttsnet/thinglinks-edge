/**
 * 真容器验证：确认参数白名单生成的配置，在真实 Docker 上确实生效。
 *
 * 单元测试只能验证我们生成的 JS 对象；Docker 是否照做必须在真实环境复核。
 * 用法： node scripts/verify-container-guard.mjs
 */
import Docker from 'dockerode';
import { buildCreateOptions, assertSafeCreateOptions } from '../dist/core/instance/container-spec.js';
import { TEST_DATA_ROOT, ensureRoot, resetDataDir } from './_data-root.mjs';

const IMAGE = 'nodered/node-red:5.0.4-24-minimal';
const NET = 'tle-verify-net';
const docker = new Docker();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

async function main() {
  console.log('\n──── 容器参数白名单 · 真实 Docker 验证 ────\n');
  await ensureRoot();

  const nets = await docker.listNetworks({ filters: { name: [NET] } });
  if (nets.length === 0) await docker.createNetwork({ Name: NET, Internal: true });

  const spec = {
    id: 'guard-test', imageTag: '5.0.4-24-minimal', memoryMb: 256, cpus: 0.5,
    ports: [{ hostPort: 30777, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1' }],
    adminRoot: '/red/guard-test/',
  };
  const opts = buildCreateOptions(spec, {
    network: NET, imageRepo: 'nodered/node-red', instanceDataRoot: TEST_DATA_ROOT,
    timezone: 'Asia/Shanghai',
  });
  assertSafeCreateOptions(opts, { instanceDataRoot: TEST_DATA_ROOT });

  await docker.getContainer(opts.name).remove({ force: true }).catch(() => {});
  const c = await docker.createContainer(opts);
  const info = await c.inspect();
  const hc = info.HostConfig;

  check('以非 root 运行', info.Config.User === 'node-red', `User=${info.Config.User}`);
  check('只读根文件系统生效', hc.ReadonlyRootfs === true);
  check('内存配额生效', hc.Memory === 256 * 1024 * 1024, `${hc.Memory / 1024 / 1024} MB`);
  check('CPU 配额生效', hc.NanoCpus === 5e8, `${hc.NanoCpus / 1e9} 核`);
  check('能力已全部裁剪', Array.isArray(hc.CapDrop) && hc.CapDrop.includes('ALL'), JSON.stringify(hc.CapDrop));
  check('no-new-privileges 生效', (hc.SecurityOpt || []).includes('no-new-privileges:true'));
  check('非特权容器', hc.Privileged === false);
  check('仅挂载本实例数据目录', (hc.Binds || []).every((b) => b === `${TEST_DATA_ROOT}/${spec.id}:/data`), JSON.stringify(hc.Binds));
  check('1880 未映射到宿主', !Object.keys(hc.PortBindings || {}).some((k) => k.startsWith('1880/')),
        Object.keys(hc.PortBindings || {}).join(',') || '(无)');
  check('已加入内部网络', Object.keys(info.NetworkSettings.Networks).includes(NET));
  check('PidsLimit 生效', hc.PidsLimit === 512, String(hc.PidsLimit));

  await c.remove({ force: true }).catch(() => {});
  await resetDataDir(spec.id);
  await docker.getNetwork(NET).remove().catch(() => {});

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('验证失败：', e.message); process.exit(1); });
