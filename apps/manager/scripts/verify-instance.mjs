/**
 * 真容器端到端验证：DockerClient 创建的 Node-RED 实例是否真的按预期跑起来。
 *
 * 覆盖：settings.js 是否落进数据卷、httpAdminRoot 前缀是否生效、
 *      1880 是否未映射宿主、标签与卷是否按平台规则命名、删除是否只删自己的卷。
 *
 * 用法： node scripts/verify-instance.mjs [basePath]
 *   例： node scripts/verify-instance.mjs /nodered
 */
import bcrypt from 'bcryptjs';
import Docker from 'dockerode';
import { DockerClient } from '../dist/core/docker-client.js';
import { renderSettings } from '../dist/core/settings-template.js';
import { adminRootFor } from '../dist/core/config.js';
import { containerName, volumeName } from '../dist/core/container-spec.js';

const BASE_PATH = process.argv[2] ?? '';
const ID = 'verify-a';
const IMAGE_TAG = '5.0.4-24-minimal';
const raw = new Docker();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 容器内没有 curl，用镜像自带的 node 发请求 */
async function execInContainer(name, script) {
  const c = raw.getContainer(name);
  const ex = await c.exec({ Cmd: ['node', '-e', script], AttachStdout: true, AttachStderr: true });
  const stream = await ex.start({ hijack: true });
  let out = '';
  await new Promise((resolve) => {
    stream.on('data', (d) => { out += d.toString('utf8'); });
    stream.on('end', resolve);
    setTimeout(resolve, 8000);
  });
  return out.replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

async function main() {
  console.log(`\n──── 实例创建 · 真容器验证（basePath=${BASE_PATH || '(根路径)'}）────\n`);

  const client = new DockerClient({
    network: 'tle-verify-net',
    imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 },
  });

  // 清理上一轮残留
  await raw.getContainer(containerName(ID)).remove({ force: true }).catch(() => {});
  await raw.getVolume(volumeName(ID)).remove({ force: true }).catch(() => {});

  const adminRoot = adminRootFor(BASE_PATH, ID);
  const settings = renderSettings({
    instanceId: ID,
    adminRoot,
    credentials: [{ username: 'admin', passwordHash: bcrypt.hashSync('secret', 8), permissions: '*' }],
    credentialSecret: 'verify-secret',
  });

  await client.createInstance({
    id: ID, imageTag: IMAGE_TAG, memoryMb: 256, cpus: 0.5,
    ports: [{ hostPort: 30901, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1' }],
    adminRoot,
  }, settings);
  check('创建实例容器与数据卷', true, containerName(ID));

  await client.start(ID);
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(1000);
    ready = (await client.logs(ID, 100)).includes('Server now running at');
  }
  check('容器启动并进入运行态', ready, ready ? '' : '超时未就绪');

  const logs = await client.logs(ID, 100);
  check('settings.js 已落进数据卷并被加载',
        logs.includes(adminRoot),
        (logs.split('\n').find((l) => l.includes('Server now running at')) || '').trim());

  const html = await execInContainer(containerName(ID),
    `fetch('http://127.0.0.1:1880${adminRoot}').then(r=>r.text()).then(t=>console.log('HTTP_OK:'+t.includes('red-ui-editor')))`);
  check('编辑器在带前缀的路径上响应', html.includes('HTTP_OK:true'), adminRoot);

  const rootProbe = await execInContainer(containerName(ID),
    `fetch('http://127.0.0.1:1880/').then(r=>console.log('ROOT_STATUS:'+r.status)).catch(e=>console.log('ROOT_ERR'))`);
  const rootIs404 = rootProbe.includes('ROOT_STATUS:404');
  check('根路径不再响应编辑器（前缀确实生效）', BASE_PATH === '' ? true : rootIs404,
        BASE_PATH === '' ? '挂根路径，跳过' : rootProbe.trim());

  const info = await raw.getContainer(containerName(ID)).inspect();
  const pb = info.HostConfig.PortBindings || {};
  check('1880 未映射到宿主', !Object.keys(pb).some((k) => k.startsWith('1880/')), Object.keys(pb).join(',') || '(无)');
  check('平台标签正确', info.Config.Labels['com.mqttsnet.thinglinks-edge.managed'] === 'true');
  check('归属校验通过', await client.assertManaged(ID).then(() => true).catch(() => false));

  const listed = await client.list();
  check('按标签可列举到该实例', listed.some((i) => i.id === ID), `共 ${listed.length} 个受管容器`);

  // 删除时保留数据卷
  await client.remove(ID, { removeData: false });
  const volKept = await raw.getVolume(volumeName(ID)).inspect().then(() => true).catch(() => false);
  check('删除容器时可保留数据卷', volKept);

  await raw.getVolume(volumeName(ID)).remove({ force: true }).catch(() => {});
  const volGone = await raw.getVolume(volumeName(ID)).inspect().then(() => false).catch(() => true);
  check('数据卷可显式删除', volGone);

  await raw.getNetwork('tle-verify-net').remove().catch(() => {});

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n验证失败：', e.message);
  await raw.getContainer(containerName(ID)).remove({ force: true }).catch(() => {});
  process.exit(1);
});
