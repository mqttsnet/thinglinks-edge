import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cidrOverlaps, checkDockerAvailable, checkArchMatch, checkCgroupMemory, checkNetworkConflict,
} from './docker.ts';

/** 可控的假 docker 端点 —— 各项检查都只读，不需要真守护进程 */
const fake = (over: Record<string, unknown> = {}) => ({
  version: async () => ({ Version: '24.0.7', ApiVersion: '1.43', Os: 'linux', Arch: 'amd64' }),
  info: async () => ({ Architecture: 'x86_64', MemoryLimit: true, SwapLimit: true,
                       CgroupVersion: '2', CgroupDriver: 'systemd' }),
  listNetworks: async () => [] as Array<Record<string, unknown>>,
  getImage: (_n: string) => ({ inspect: async () => ({ Architecture: 'amd64' }) }),
  ...over,
} as Parameters<typeof checkDockerAvailable>[0]);

// ── CIDR 重叠：算错也不报错，最该被钉死 ─────────────

test('同段与包含关系都算重叠', () => {
  assert.equal(cidrOverlaps('172.17.0.0/16', '172.17.0.0/16'), true);
  assert.equal(cidrOverlaps('172.17.0.0/16', '172.17.5.0/24'), true, '窄段落在宽段里');
  assert.equal(cidrOverlaps('172.16.0.0/12', '172.17.0.0/16'), true, 'docker 默认段落在企业 B 类里');
  assert.equal(cidrOverlaps('10.0.0.0/8', '10.42.7.0/24'), true);
});

test('不相干的网段不算重叠', () => {
  assert.equal(cidrOverlaps('172.17.0.0/16', '192.168.1.0/24'), false);
  assert.equal(cidrOverlaps('10.0.0.0/8', '172.16.0.0/12'), false);
  assert.equal(cidrOverlaps('192.168.1.0/24', '192.168.2.0/24'), false, '相邻但不重叠');
});

test('/0 与任何网段都重叠 —— 默认路由这种写法必须报出来', () => {
  assert.equal(cidrOverlaps('0.0.0.0/0', '172.17.0.0/16'), true);
});

test('解析不了的输入按不重叠处理，不抛错', () => {
  assert.equal(cidrOverlaps('不是网段', '10.0.0.0/8'), false);
  assert.equal(cidrOverlaps('10.0.0.0', '10.0.0.0/8'), false, '缺前缀长度');
  assert.equal(cidrOverlaps('10.0.0.0/33', '10.0.0.0/8'), false, '前缀越界');
});

// ── Docker 可用性 ────────────────────────────────

test('版本达标即通过，并记下读数', async () => {
  const r = await checkDockerAvailable(fake());
  assert.equal(r.status, 'pass');
  assert.equal(r.data?.['version'], '24.0.7');
});

test('版本过老要阻断，并说清后果', async () => {
  const r = await checkDockerAvailable(fake({ version: async () => ({ Version: '19.03.15' }) }));
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'block');
  assert.match(r.detail, /不生效/, '要说清「限额配了但不生效且不报错」这个后果');
});

test('连不上要阻断，而不是跳过', async () => {
  const r = await checkDockerAvailable(fake({
    version: async () => { throw new Error('ECONNREFUSED /var/run/docker.sock'); },
  }));
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'block');
  assert.match(r.detail, /ECONNREFUSED/);
});

// ── 架构 ────────────────────────────────────────

test('x86_64 与 amd64 是同一个架构，不能误报', async () => {
  const r = await checkArchMatch(fake(), ['nodered/node-red:5.0.4']);
  assert.equal(r.status, 'pass', 'docker info 说 x86_64、镜像说 amd64，两者相同');
});

test('架构不符要阻断并列出是哪些镜像', async () => {
  const r = await checkArchMatch(fake({
    getImage: () => ({ inspect: async () => ({ Architecture: 'arm64' }) }),
  }), ['nodered/node-red:5.0.4']);
  assert.equal(r.severity, 'block');
  assert.match(r.detail, /arm64/);
});

/*
 * 本机没有镜像时**跳过而不是通过** —— 没检查就是没检查。
 * 报成通过会让离线现场以为架构已经核对过了。
 */
test('本机没有目标镜像时跳过，并提醒离线现场自行确认', async () => {
  const r = await checkArchMatch(fake({
    getImage: () => ({ inspect: async () => { throw new Error('no such image'); } }),
  }), ['nodered/node-red:5.0.4']);
  assert.equal(r.status, 'skip');
  assert.match(r.detail, /离线现场/);
});

// ── cgroup ──────────────────────────────────────

test('内存 cgroup 不可用要告警，并说清「配额看起来正常但不生效」', async () => {
  const r = await checkCgroupMemory(fake({
    info: async () => ({ MemoryLimit: false, SwapLimit: false, CgroupVersion: '1' }),
  }));
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warn');
  assert.match(r.detail, /不会生效/);
});

test('swap 限额不可用时通过但要说明后果', async () => {
  const r = await checkCgroupMemory(fake({
    info: async () => ({ MemoryLimit: true, SwapLimit: false, CgroupVersion: '2' }),
  }));
  assert.equal(r.status, 'pass');
  assert.match(r.detail, /swap/);
});

// ── 网段冲突 ────────────────────────────────────

test('没声明企业网段时跳过，并说明为什么只能靠声明', async () => {
  const r = await checkNetworkConflict(fake(), []);
  assert.equal(r.status, 'skip');
  assert.match(r.detail, /容器内看不到宿主路由表/);
});

test('网段重叠要告警并给出改法', async () => {
  const r = await checkNetworkConflict(fake({
    listNetworks: async () => [
      { Name: 'bridge', IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] } },
    ],
  }), ['172.16.0.0/12']);
  assert.equal(r.severity, 'warn');
  assert.match(r.detail, /default-address-pools/, '要给出可照做的改法');
});

test('不重叠时通过并报出比对了几段', async () => {
  const r = await checkNetworkConflict(fake({
    listNetworks: async () => [
      { Name: 'bridge', IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] } },
    ],
  }), ['10.0.0.0/8']);
  assert.equal(r.status, 'pass');
});
