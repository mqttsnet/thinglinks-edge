import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidId, assertValidSpec, buildCreateOptions, assertSafeCreateOptions,
  SpecError, containerName, volumeName, type InstanceSpec,
} from './container-spec.ts';

const RANGE = { min: 30000, max: 30999 };
const spec = (over: Partial<InstanceSpec> = {}): InstanceSpec => ({
  id: 'line-a', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5,
  ports: [{ hostPort: 30001, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1' }],
  adminRoot: '/red/line-a/', ...over,
});
const build = (s: InstanceSpec) => buildCreateOptions(s, { network: 'tle-net', imageRepo: 'nodered/node-red' });

test('实例 ID 严格字符集 —— 它会进容器名、卷名与访问路径', () => {
  assertValidId('line-a');
  for (const bad of ['Line-A', '-abc', 'ab', 'a'.repeat(40), 'a b', 'a/b', '../etc', 'a_b', 'abc-']) {
    assert.throws(() => assertValidId(bad), SpecError, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('资源配额与端口范围越界被拒', () => {
  assertValidSpec(spec(), RANGE);
  assert.throws(() => assertValidSpec(spec({ memoryMb: 32 }), RANGE), SpecError);
  assert.throws(() => assertValidSpec(spec({ cpus: 0 }), RANGE), SpecError);
  assert.throws(() => assertValidSpec(spec({ ports: [{ hostPort: 29000, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1' }] }), RANGE), SpecError);
});

test('同一实例内宿主端口重复被拒', () => {
  const dup = spec({ ports: [
    { hostPort: 30001, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1' },
    { hostPort: 30001, containerPort: 502, protocol: 'tcp', hostIp: '127.0.0.1' },
  ] });
  assert.throws(() => assertValidSpec(dup, RANGE), SpecError);
});

test('生成的配置默认安全：非 root、只读根、能力全裁、配额生效', () => {
  const o = build(spec());
  const hc = o['HostConfig'] as Record<string, unknown>;
  assert.equal(o['User'], 'node-red');
  assert.equal(hc['ReadonlyRootfs'], true);
  assert.deepEqual(hc['CapDrop'], ['ALL']);
  assert.deepEqual(hc['SecurityOpt'], ['no-new-privileges:true']);
  assert.equal(hc['Memory'], 512 * 1024 * 1024);
  assert.equal(hc['NanoCpus'], 5e8);
  assert.deepEqual(hc['Binds'], ['tle-nr-line-a-data:/data']);
  assertSafeCreateOptions(o);
});

test('1880 绝不映射宿主 —— 唯一入口必须是 Manager 反代', () => {
  const o = build(spec());
  const pb = (o['HostConfig'] as Record<string, unknown>)['PortBindings'] as Record<string, unknown>;
  assert.ok(!Object.keys(pb).some((k) => k.startsWith('1880/')));

  const tampered = build(spec());
  ((tampered['HostConfig'] as Record<string, unknown>)['PortBindings'] as Record<string, unknown>)['1880/tcp'] =
    [{ HostIp: '0.0.0.0', HostPort: '1880' }];
  assert.throws(() => assertSafeCreateOptions(tampered), SpecError);
});

test('六类提权参数被二次校验拦截', () => {
  const cases: Array<[string, (hc: Record<string, unknown>) => void]> = [
    ['Privileged', (hc) => { hc['Privileged'] = true; }],
    ['任意 bind 挂宿主根', (hc) => { hc['Binds'] = ['/:/host']; }],
    ['host 网络', (hc) => { hc['NetworkMode'] = 'host'; }],
    ['host PID', (hc) => { hc['PidMode'] = 'host'; }],
    ['CapAdd', (hc) => { hc['CapAdd'] = ['SYS_ADMIN']; }],
    ['挂载 docker socket', (hc) => { hc['Binds'] = ['/var/run/docker.sock:/var/run/docker.sock']; }],
  ];
  for (const [name, mutate] of cases) {
    const o = build(spec());
    mutate(o['HostConfig'] as Record<string, unknown>);
    assert.throws(() => assertSafeCreateOptions(o), SpecError, `应拦截：${name}`);
  }
});

test('关闭只读根或改回 root 运行会被拦截', () => {
  const a = build(spec());
  (a['HostConfig'] as Record<string, unknown>)['ReadonlyRootfs'] = false;
  assert.throws(() => assertSafeCreateOptions(a), SpecError);

  const b = build(spec());
  b['User'] = 'root';
  assert.throws(() => assertSafeCreateOptions(b), SpecError);
});

test('容器名与卷名按实例 id 派生', () => {
  assert.equal(containerName('line-a'), 'tle-nr-line-a');
  assert.equal(volumeName('line-a'), 'tle-nr-line-a-data');
});
