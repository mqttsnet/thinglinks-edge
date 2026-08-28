/**
 * 流程模板端到端验证（T4.6）—— 对着**两台真实 Node-RED 容器**跑。
 *
 * 验收标准是「模板套用后实例可正常部署」，所以必须有真实例：
 * 假的 Admin API 证明不了「Node-RED 真的接受了这套流程并把它跑起来了」。
 *
 * 主线：实例 A 部署一套流程 → 导成模板 → 套到实例 B → 回读 B 确认一致。
 * 顺带验三件在现场真会咬人的事：
 *   · 缺节点类型时能提前发现（Node-RED 遇到未知节点**不报错**）
 *   · 模板里的内联密钥会被扫出来（凭据不会导出，但 function 里硬编码的会）
 *   · 套用是实例级破坏性操作，必须过实例授权矩阵
 */
import Docker from 'dockerode';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/auth/crypto.js';
import { AuthService } from '../dist/core/auth/service.js';
import { InstanceRepo } from '../dist/core/instance/repo.js';
import { InstanceService } from '../dist/core/instance/service.js';
import { DockerClient } from '../dist/core/instance/docker-client.js';
import { buildServer } from '../dist/http/app.js';
import { UserRepo } from '../dist/core/auth/user-repo.js';
import { containerName } from '../dist/core/instance/container-spec.js';
import { TEST_DATA_ROOT, TEST_EDGE_ROOT, ensureRoot, resetDataDir } from './_data-root.mjs';
import { adminSession, sessionFor } from './_session.mjs';

const NET = 'tle-tpl-net';
const BRIDGE = 'tle-tpl-bridge';
const PORT = 13285;
const ADMIN_PW = 'initial-password-123';
const SRC = 'tpl-src';
const DST = 'tpl-dst';
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

async function cleanup() {
  for (const id of [SRC, DST]) {
    await raw.getContainer(`${BRIDGE}-${id}`).remove({ force: true }).catch(() => {});
    await raw.getContainer(containerName(id)).remove({ force: true }).catch(() => {});
    /*
     * **每实例网络**也要删。DockerClient 给每台实例单独建一个
     * `<NET>-<id>` 网络做隔离，删容器不会连带删网络 ——
     * 漏了这一步，残留检查会报「网络 N」而容器和卷都是干净的，
     * 那种报告最容易被当成误报忽略掉。
     */
    await raw.getNetwork(`${NET}-${id}`).remove().catch(() => {});
    await resetDataDir(id);
  }
  await raw.getNetwork(NET).remove().catch(() => {});
}

/** 一套有代表性的流程：含标签页、mqtt 节点、function、debug */
const FLOWS = [
  { id: 'tabA', type: 'tab', label: '产线采集' },
  { id: 'brkA', type: 'mqtt-broker', name: '现场broker', broker: '10.0.0.9', port: '1883' },
  { id: 'inA', type: 'mqtt in', z: 'tabA', name: '温度', topic: 'plant/temp',
    broker: 'brkA', x: 150, y: 100, wires: [['fnA']] },
  { id: 'fnA', type: 'function', z: 'tabA', name: '换算',
    func: 'msg.payload = Number(msg.payload) / 10;\nreturn msg;', outputs: 1,
    x: 330, y: 100, wires: [['dbgA']] },
  { id: 'dbgA', type: 'debug', z: 'tabA', name: '输出', x: 500, y: 100, wires: [] },
];

async function main() {
  console.log('\n──── 流程模板 · 两台真实 Node-RED 验证 ────\n');
  await cleanup();

  const dataDir = mkdtempSync(join(tmpdir(), 'tle-tpl-'));
  const db = openDb(join(dataDir, 'edge.db'));
  const auth = new AuthService(db);
  auth.ensureInitialUser('admin', ADMIN_PW);
  const repo = new InstanceRepo(db, deriveKey('verify', 'salt'));
  await ensureRoot();

  const users = new UserRepo(db);
  const opsPassword = users.create('ops', 'operator', 'admin');
  const viewerPassword = users.create('watcher', 'viewer', 'admin');

  const docker = new DockerClient({
    network: NET, imageRepo: 'nodered/node-red',
    portRange: { min: 30000, max: 30999 }, instanceDataRoot: TEST_DATA_ROOT, timezone: 'Asia/Shanghai',
  });
  const service = new InstanceService({
    db, repo, docker, basePath: '', portRange: { min: 30000, max: 30999 }, allowedImageTags: [TAG],
  });
  const config = {
    externalUrl: `http://127.0.0.1:${PORT}`, basePath: '', cookieSecure: false,
    allowedOrigins: [`http://127.0.0.1:${PORT}`], listenAddr: '127.0.0.1', listenPort: PORT,
    dataDir, dataRoot: TEST_EDGE_ROOT, instanceDataRoot: TEST_DATA_ROOT,
    portRange: { min: 30000, max: 30999 }, timezone: 'Asia/Shanghai', updateCheckUrl: '',
  };

  /*
   * Manager 跑在宿主上，而实例容器在 docker 网络里 —— 宿主按容器名解析不了。
   * 所以这里把上游改成宿主可达的 127.0.0.1:<映射端口>。
   * 生产里 Manager 与实例同处一个网络，用的是默认的容器名解析，不需要这一层。
   */
  const hostPorts = new Map();
  const app = buildServer({
    config, db, auth, repo, service,
    upstreamFor: (id) => `http://127.0.0.1:${hostPorts.get(id)}`,
  });
  await app.listen({ host: '127.0.0.1', port: PORT });
  server = app;
  const B = `http://127.0.0.1:${PORT}`;

  const H = (s) => ({ cookie: s.cookie, 'content-type': 'application/json', 'x-csrf-token': s.csrf });

  // 先改掉初始口令：强制改密是后端闸门，不改的话后面每条业务接口都会 403
  const admin = await adminSession(B, ADMIN_PW);
  check('管理员登录成功', Boolean(admin.csrf));

  /*
   * ── 建两台实例 ──
   *
   * **不映射 1880**：产品明令禁止（「唯一入口必须是 Manager 反代」），
   * 服务端会当场拒绝。宿主上的测试进程要访问实例，走 socat 边车搭桥 ——
   * 这是测试脚手架，不改变生产拓扑。与 verify-proxy 用的是同一套做法。
   */
  for (const id of [SRC, DST]) {
    const res = await fetch(`${B}/api/instances`, {
      method: 'POST', headers: H(admin),
      body: JSON.stringify({ id, name: id, imageTag: TAG, memoryMb: 512, cpus: 0.5, ports: [] }),
    });
    check(`创建实例 ${id}`, res.status === 201,
          res.status === 201 ? '' : `HTTP ${res.status} ${JSON.stringify(await res.json()).slice(0, 160)}`);
  }

  for (const id of [SRC, DST]) {
    let state = 'missing';
    for (let i = 0; i < 40 && state !== 'running'; i++) { await sleep(1000); state = await containerState(id); }
    check(`${id} 容器在运行`, state === 'running', `state=${state}`);
  }

  // 每台实例一个 socat 边车，把容器内的 1880 转到宿主端口供本进程访问
  for (const [id, bridgePort] of [[SRC, 30930], [DST, 30931]]) {
    hostPorts.set(id, bridgePort);
    await raw.createContainer({
      name: `${BRIDGE}-${id}`, Image: 'alpine/socat',
      Cmd: [`TCP-LISTEN:${bridgePort},fork,reuseaddr`, `TCP:${containerName(id)}:1880`],
      ExposedPorts: { [`${bridgePort}/tcp`]: {} },
      HostConfig: {
        NetworkMode: docker.instanceNetwork(id),
        PortBindings: { [`${bridgePort}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(bridgePort) }] },
      },
    }).then((c) => c.start());
  }
  await sleep(1500);

  // 等两台 Node-RED 的 Admin API 真的起来
  const ready = async (id) => {
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`${B}/api/instances/${id}/flows`, { headers: { cookie: admin.cookie } })
        .catch(() => null);
      if (r && r.status === 200) return true;
      await sleep(1000);
    }
    return false;
  };
  check(`${SRC} Admin API 就绪`, await ready(SRC));
  check(`${DST} Admin API 就绪`, await ready(DST));

  // ── 1. 往源实例部署一套流程 ───────────────────────
  const deployed = await fetch(`${B}/api/instances/${SRC}/flows`, {
    method: 'POST', headers: H(admin), body: JSON.stringify({ flows: FLOWS }),
  });
  const deployBody = await deployed.json();
  check('直接提交流程可部署到实例', deployed.status === 200, `HTTP ${deployed.status}`);
  check('部署返回的是 Node-RED 的真实状态码', deployBody.deployStatus === 204,
        `deployStatus=${deployBody.deployStatus}（验收标准写的 200 是宽泛说法，实测 204）`);
  check('部署结果报出节点与标签页数', deployBody.nodeCount === 5 && deployBody.tabCount === 1,
        `${deployBody.nodeCount} 节点 / ${deployBody.tabCount} 标签页`);

  // ── 2. 从源实例导出 ───────────────────────────────
  const exported = await (await fetch(`${B}/api/instances/${SRC}/flows`,
    { headers: { cookie: admin.cookie } })).json();
  check('导出的流程节点数与部署的一致', exported.nodeCount === 5, `${exported.nodeCount} 个`);
  check('导出内容含我们部署的那个 function',
        exported.flows.some((n) => n.id === 'fnA' && n.func.includes('Number(msg.payload)')));
  check('导出不含 credentials 字段（实测 Node-RED 不外带凭据）',
        !JSON.stringify(exported.flows).includes('credentials'));

  // ── 3. 存成模板 ───────────────────────────────────
  const createdTpl = await fetch(`${B}/api/templates`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ name: '产线采集基线', description: '标准三段式', instanceId: SRC }),
  });
  const tpl = (await createdTpl.json()).template;
  check('从实例建模板返回 201', createdTpl.status === 201, `HTTP ${createdTpl.status}`);
  check('模板记录了来源实例', tpl.source === SRC, tpl.source);
  check('模板存下了节点类型清单', tpl.nodeTypes.includes('mqtt in') && tpl.nodeTypes.includes('function'),
        tpl.nodeTypes.join(' '));
  check('干净模板没有内联凭据告警', tpl.warnings.length === 0);

  const list = await (await fetch(`${B}/api/templates`, { headers: { cookie: admin.cookie } })).json();
  check('模板出现在列表里', list.templates.length === 1);
  check('列表不带 flows 内容（模板可能几百 KB）', !('flows' in list.templates[0]));
  /*
   * 列表页把下面这些逐个显示出来。后端少回一个字段，界面上就是一处空白或
   * 「Invalid Date」，而接口测试全绿 —— 所以按**页面实际要读的字段**来断言。
   */
  const row = list.templates[0];
  check('列表项带齐控制台要显示的字段',
        typeof row.description === 'string' && typeof row.source === 'string'
        && Array.isArray(row.warnings) && typeof row.tabCount === 'number',
        Object.keys(row).join(' '));
  check('列表项带得出「谁建的、什么时候」',
        row.createdBy === 'admin' && !Number.isNaN(Date.parse(row.createdAt)),
        `${row.createdBy} / ${row.createdAt}`);

  const dl = await fetch(`${B}/api/templates/${tpl.id}/download`, { headers: { cookie: admin.cookie } });
  const cd = dl.headers.get('content-disposition') ?? '';
  check('模板可下载成文件供跨项目复用', dl.status === 200 && cd.includes('attachment'),
        `HTTP ${dl.status}`);
  check('中文模板名走 RFC 5987，不把 header 撑爆',
        cd.includes("filename*=UTF-8''")
        && decodeURIComponent(cd.split("UTF-8''")[1] ?? '').includes('产线采集基线'),
        cd.slice(0, 90));
  check('下载内容是可解析的 flows 数组', Array.isArray(JSON.parse(await dl.text())));

  // ── 4. 套用前的空跑检查 ───────────────────────────
  const dry = await (await fetch(`${B}/api/instances/${DST}/flows`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ templateId: tpl.id, dryRun: true }),
  })).json();
  check('空跑给出兼容性结论', dry.dryRun === true && dry.compat.ok === true, dry.note);
  /*
   * **关键**：确认这次是真查过，不是取不到清单后按默认值放行。
   * 少了这条，`getInstalledTypes` 哪天永远抛异常都测不出来 ——
   * 每次都回 `ok: true`，套用照做，界面一路绿灯，
   * 而「缺节点」这个最费时间的现场问题从此再也报不出来。
   */
  check('空跑确实读到了目标实例的节点清单（不是取不到后按默认放行）',
        dry.compat.checked === true, `checked=${dry.compat.checked}`);

  const beforeApply = await (await fetch(`${B}/api/instances/${DST}/flows`,
    { headers: { cookie: admin.cookie } })).json();
  check('空跑没有改动目标实例', beforeApply.nodeCount === 0, `${beforeApply.nodeCount} 个节点`);

  // ── 5. 套用（验收主线）─────────────────────────────
  const applied = await fetch(`${B}/api/instances/${DST}/flows`, {
    method: 'POST', headers: H(admin), body: JSON.stringify({ templateId: tpl.id }),
  });
  const applyBody = await applied.json();
  check('套用模板成功', applied.status === 200 && applyBody.applied === true, `HTTP ${applied.status}`);
  check('目标实例接受并部署了流程', applyBody.deployStatus === 204, `deployStatus=${applyBody.deployStatus}`);
  // 控制台靠这个数字告诉用户「刚才覆盖掉了多少」。目标实例原本是空的，所以应为 0，
  // 而不是 null —— null 表示「没读到」，那时界面会隐掉这句话
  check('回报被替换掉的旧流程节点数', applyBody.replacedNodeCount === 0,
        String(applyBody.replacedNodeCount));

  const after = await (await fetch(`${B}/api/instances/${DST}/flows`,
    { headers: { cookie: admin.cookie } })).json();
  check('回读目标实例，流程与模板一致', after.nodeCount === 5, `${after.nodeCount} 个节点`);
  check('function 代码原样搬过来了',
        after.flows.some((n) => n.id === 'fnA' && n.func.includes('Number(msg.payload)')));
  check('标签页也搬过来了', after.flows.some((n) => n.type === 'tab' && n.label === '产线采集'));

  /*
   * 真正的验收：不只是「API 回了 200」，而是 Node-RED **把这套流程跑起来了**。
   * 直接问实例自己的运行时状态 —— 它认不认这套流程，它自己最清楚。
   */
  /*
   * 绕开 Manager 直接问实例。实例开着 adminAuth，所以必须先换令牌 ——
   * 裸访问回 401 是**正确**行为（顺带证明了实例没被我们的边车暴露成无鉴权）。
   */
  const dstRoot = (await (await fetch(`${B}/api/instances/${DST}`,
    { headers: { cookie: admin.cookie } })).json()).instance.adminRoot;
  const direct = `http://127.0.0.1:${hostPorts.get(DST)}${dstRoot}`;

  const naked = await fetch(`${direct}flows`, { headers: { accept: 'application/json' } })
    .catch(() => null);
  check('边车没把实例暴露成无鉴权（裸访问被拒）', naked?.status === 401, `HTTP ${naked?.status}`);

  const cred = repo.credentials(DST)[0];
  const tok = await (await fetch(`${direct}auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'node-red-editor', grant_type: 'password', scope: '*',
                           username: cred.username, password: cred.password }),
  })).json();
  const nrRuntime = await fetch(`${direct}flows`, {
    headers: { accept: 'application/json', authorization: `Bearer ${tok.access_token}` },
  }).catch(() => null);
  const runtimeFlows = nrRuntime?.status === 200 ? await nrRuntime.json() : null;
  check('绕开 Manager 直接问实例，流程确实在运行时里',
        Array.isArray(runtimeFlows) && runtimeFlows.some((n) => n.id === 'fnA'),
        Array.isArray(runtimeFlows) ? `${runtimeFlows.length} 个节点` : `HTTP ${nrRuntime?.status}`);

  // ── 6. 内联密钥会被扫出来 ─────────────────────────
  const dirty = await fetch(`${B}/api/templates`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({
      name: '带密钥的模板',
      content: [
        { id: 'tabX', type: 'tab', label: 'x' },
        { id: 'fnX', type: 'function', z: 'tabX', name: '上云',
          func: "const apiKey = 'sk-live-secret-0011';\nreturn msg;" },
      ],
    }),
  });
  const dirtyTpl = (await dirty.json()).template;
  check('function 里硬编码的密钥被扫出来', dirtyTpl.warnings.length === 1, dirtyTpl.warnings[0]);
  check('告警指出是哪个节点', /上云/.test(dirtyTpl.warnings[0] ?? ''));
  const stored = (await (await fetch(`${B}/api/templates/${dirtyTpl.id}`,
    { headers: { cookie: admin.cookie } })).json()).template;
  const storedFn = stored.flows.find((n) => n.id === 'fnX');
  check('只告警不剥离 —— function 代码原样保留（剥离会把代码改坏）',
        storedFn.func === "const apiKey = 'sk-live-secret-0011';\nreturn msg;",
        storedFn.func.slice(0, 40));

  // ── 7. 缺节点类型能提前发现 ───────────────────────
  const exotic = await fetch(`${B}/api/templates`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({
      name: '用了没装的节点',
      content: [
        { id: 'tabZ', type: 'tab', label: 'z' },
        { id: 'mb', type: 'modbus-read', z: 'tabZ', name: '读寄存器' },
      ],
    }),
  });
  const exoticTpl = (await exotic.json()).template;
  const dryExotic = await (await fetch(`${B}/api/instances/${DST}/flows`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ templateId: exoticTpl.id, dryRun: true }),
  })).json();
  check('缺节点的判定也是查过之后给的', dryExotic.compat.checked === true,
        `checked=${dryExotic.compat.checked}`);
  check('空跑发现目标实例缺 modbus-read',
        dryExotic.compat.ok === false && dryExotic.compat.missing.includes('modbus-read'),
        dryExotic.compat.missing?.join(' '));
  check('缺节点时说清后果（Node-RED 不会报错）', /不报错/.test(dryExotic.note ?? ''), dryExotic.note);
  check('tab 不被误报成缺失', !dryExotic.compat.missing.includes('tab'));

  // ── 8. 非法模板被拒 ───────────────────────────────
  const badJson = await fetch(`${B}/api/templates`, {
    method: 'POST', headers: H(admin), body: JSON.stringify({ name: 'bad', content: '{"a":1}' }),
  });
  check('顶层不是数组的模板被拒', badJson.status === 400, (await badJson.json()).error?.slice(0, 30));

  const dupId = await fetch(`${B}/api/templates`, {
    method: 'POST', headers: H(admin),
    body: JSON.stringify({ name: 'dup', content: [{ id: 'a', type: 'tab' }, { id: 'a', type: 'debug' }] }),
  });
  check('节点 id 重复被拒（Node-RED 会静默覆盖）', dupId.status === 400);

  // ── 9. 权限 ───────────────────────────────────────
  const viewer = await sessionFor(B, 'watcher', viewerPassword);
  const vList = await fetch(`${B}/api/templates`, { headers: { cookie: viewer.cookie } });
  check('只读用户可以看模板列表', vList.status === 200, `HTTP ${vList.status}`);
  const vCreate = await fetch(`${B}/api/templates`, {
    method: 'POST', headers: H(viewer), body: JSON.stringify({ name: 'x', content: [] }),
  });
  check('只读用户建不了模板', vCreate.status === 403, `HTTP ${vCreate.status}`);
  const vApply = await fetch(`${B}/api/instances/${DST}/flows`, {
    method: 'POST', headers: H(viewer), body: JSON.stringify({ templateId: tpl.id }),
  });
  check('只读用户套不了模板', vApply.status === 403, `HTTP ${vApply.status}`);

  /*
   * 关键一条：运维有模板管理权，但**没有这台实例的授权**时不能套。
   * 否则「能管模板」就成了动任意产线的旁路。
   */
  const ops = await sessionFor(B, 'ops', opsPassword);
  const opsApply = await fetch(`${B}/api/instances/${DST}/flows`, {
    method: 'POST', headers: H(ops), body: JSON.stringify({ templateId: tpl.id }),
  });
  check('运维没有实例授权时套不了模板（模板权限不是实例旁路）',
        opsApply.status === 403, `HTTP ${opsApply.status}`);

  const opsExport = await fetch(`${B}/api/templates`, {
    method: 'POST', headers: H(ops), body: JSON.stringify({ name: '越权导出', instanceId: SRC }),
  });
  check('运维没有实例授权时也导不出该实例的流程', opsExport.status === 403, `HTTP ${opsExport.status}`);

  // 授权之后就能套
  users.grant('ops', DST, 'operate', 'admin');
  const opsApply2 = await fetch(`${B}/api/instances/${DST}/flows`, {
    method: 'POST', headers: H(ops), body: JSON.stringify({ templateId: tpl.id }),
  });
  check('授权后运维可以套用', opsApply2.status === 200, `HTTP ${opsApply2.status}`);

  const anon = await fetch(`${B}/api/templates`);
  check('未登录访问模板被拒', anon.status === 401, `HTTP ${anon.status}`);

  // ── 9.5 改名与说明 ────────────────────────────────
  /*
   * 控制台的「改名」按钮走这条。改名只动元信息**不动流程内容** ——
   * 如果它把 content 一起写坏，套用出去的是错流程而接口仍回 200，
   * 所以下面要回读一次内容做对照。
   */
  const beforeRename = await (await fetch(`${B}/api/templates/${tpl.id}`,
    { headers: { cookie: admin.cookie } })).json();
  const renamed = await fetch(`${B}/api/templates/${tpl.id}`, {
    method: 'PATCH', headers: H(admin),
    body: JSON.stringify({ name: '产线采集基线 v2', description: '加了限幅' }),
  });
  const renamedTpl = (await renamed.json()).template;
  check('改名返回 200 且用的是新名字', renamed.status === 200 && renamedTpl.name === '产线采集基线 v2',
        `HTTP ${renamed.status} ${renamedTpl?.name}`);
  check('说明一并更新', renamedTpl.description === '加了限幅', renamedTpl.description);

  const afterRename = await (await fetch(`${B}/api/templates/${tpl.id}`,
    { headers: { cookie: admin.cookie } })).json();
  check('改名不动流程内容',
        JSON.stringify(afterRename.template.flows) === JSON.stringify(beforeRename.template.flows),
        `${afterRename.template.nodeCount} 个节点`);
  check('改名不动来源与创建者', afterRename.template.source === SRC
        && afterRename.template.createdBy === beforeRename.template.createdBy);

  const emptyName = await fetch(`${B}/api/templates/${tpl.id}`, {
    method: 'PATCH', headers: H(admin), body: JSON.stringify({ name: '   ', description: '' }),
  });
  check('改成空名被拒', emptyName.status === 400, `HTTP ${emptyName.status}`);
  // 新建时拦 64 字，改名时也必须拦 —— 否则「建完再改一次」就绕过去了
  const longName = await fetch(`${B}/api/templates/${tpl.id}`, {
    method: 'PATCH', headers: H(admin), body: JSON.stringify({ name: '长'.repeat(65), description: '' }),
  });
  check('改成超长名被拒（与新建同一条规则）', longName.status === 400, `HTTP ${longName.status}`);

  const ghost = await fetch(`${B}/api/templates/00000000-0000-0000-0000-000000000000`, {
    method: 'PATCH', headers: H(admin), body: JSON.stringify({ name: 'x', description: '' }),
  });
  check('改不存在的模板回 404', ghost.status === 404, `HTTP ${ghost.status}`);

  const viewerRename = await fetch(`${B}/api/templates/${tpl.id}`, {
    method: 'PATCH', headers: H(viewer), body: JSON.stringify({ name: 'x', description: '' }),
  });
  check('只读用户改不了模板', viewerRename.status === 403, `HTTP ${viewerRename.status}`);

  // ── 10. 审计 ──────────────────────────────────────
  const audits = db.prepare("SELECT actor, action, target, result FROM audit WHERE action LIKE 'template-%'").all();
  check('建模板进审计', audits.some((a) => a.action === 'template-create'));
  check('改名进审计', audits.some((a) => a.action === 'template-rename'));
  check('套用进审计并记下目标实例',
        audits.some((a) => a.action === 'template-apply' && a.target === DST),
        `共 ${audits.length} 条模板审计`);

  // ── 11. 删除 ──────────────────────────────────────
  const del = await fetch(`${B}/api/templates/${exoticTpl.id}`, { method: 'DELETE', headers: H(admin) });
  check('删除模板返回 204', del.status === 204, `HTTP ${del.status}`);
  const gone = await fetch(`${B}/api/templates/${exoticTpl.id}`, { headers: { cookie: admin.cookie } });
  check('删除后取不到', gone.status === 404, `HTTP ${gone.status}`);

  await app.close();
  await cleanup();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('  失败：' + failed.map((f) => f.name).join('、'));
    process.exitCode = 1;
  }
}

/*
 * 出错时也要把 HTTP 服务关掉。不关的话端口一直被占着，
 * 下一次跑直接 EADDRINUSE —— 上一个错误还没查完，又多了一个假故障。
 */
let server;
main().catch(async (e) => {
  console.error('\n[fatal]', e);
  await cleanup();
  process.exitCode = 1;
}).finally(async () => {
  await server?.close().catch(() => {});
});
