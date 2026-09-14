import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkBootstrapEntrypoint, INSTANCE_IPV6_SYSCTLS } from './network-bootstrap.ts';
import {
  assertValidId, assertValidSpec, buildCreateOptions, assertSafeCreateOptions,
  buildMigrationProbeCreateOptions, assertSafeMigrationProbeOptions,
  migrationProbeDataDir, migrationProbeName, migrationProbeNetworkName,
  MIGRATION_TX_LABEL, MIGRATION_PROBE_LABEL,
  SpecError, containerName, instanceDataDir, BOOTSTRAP_TX_LABEL, type InstanceSpec,
} from './container-spec.ts';

const RANGE = { min: 30000, max: 30999 };
const spec = (over: Partial<InstanceSpec> = {}): InstanceSpec => ({
  id: 'line-a', imageTag: '5.0.4-24-minimal', memoryMb: 512, cpus: 0.5,
  ports: [{ hostPort: 30001, containerPort: 1883, protocol: 'tcp', hostIp: '127.0.0.1' }],
  adminRoot: '/red/line-a/', ...over,
});
const DATA_ROOT = '/data01/mqttsnet/thinglinks-edge/instances';
const build = (s: InstanceSpec) =>
  buildCreateOptions(s, {
    network: 'tle-net', imageRepo: 'nodered/node-red',
    instanceDataRoot: DATA_ROOT, timezone: 'Asia/Shanghai',
  });
const guard = (o: Record<string, unknown>) => assertSafeCreateOptions(o, {
  instanceDataRoot: DATA_ROOT, expectedNetwork: 'tle-net',
});

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
  assert.equal(o['User'], '1000:1000');
  assert.deepEqual(o['Entrypoint'], networkBootstrapEntrypoint());
  assert.deepEqual(o['Cmd'], []);
  assert.equal(hc['ReadonlyRootfs'], true);
  assert.deepEqual(hc['CapDrop'], ['ALL']);
  assert.deepEqual(hc['SecurityOpt'], ['no-new-privileges:true']);
  assert.equal(hc['Memory'], 512 * 1024 * 1024);
  assert.equal(hc['MemorySwap'], hc['Memory']);
  assert.deepEqual(hc['Sysctls'], INSTANCE_IPV6_SYSCTLS);
  assert.deepEqual(hc['LogConfig'], {
    Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' },
  });
  assert.equal(hc['NanoCpus'], 5e8);
  assert.deepEqual(hc['Binds'], [`${DATA_ROOT}/line-a:/data`]);
  guard(o);
});

test('协议库配置目录固定在受管 data，不能缺失、越界或重复覆盖', () => {
  const options=build(spec());
  assert.ok((options['Env'] as string[]).includes('XDG_CONFIG_HOME=/data/.config'));
  guard(options);
  for (const entries of [[], ['XDG_CONFIG_HOME=/root/.config'],
    ['XDG_CONFIG_HOME=/data/.config','XDG_CONFIG_HOME=/tmp/config']]) {
    const invalid=build(spec());
    invalid['Env']=[...(invalid['Env'] as string[]).filter((value)=>!value.startsWith('XDG_CONFIG_HOME=')),...entries];
    assert.throws(()=>guard(invalid),/配置目录/);
  }
});

test('bootstrap container gets the exact tx owner label while ordinary rebuilds never do', () => {
  const ordinary = build(spec());
  assert.equal((ordinary['Labels'] as Record<string, unknown>)[BOOTSTRAP_TX_LABEL], undefined);

  const bootstrap = buildCreateOptions(spec(), {
    network: 'tle-net', imageRepo: 'nodered/node-red',
    instanceDataRoot: DATA_ROOT, timezone: 'Asia/Shanghai',
    bootstrapTxId: 'bootstrap-tx-01',
  });
  assert.equal(
    (bootstrap['Labels'] as Record<string, unknown>)[BOOTSTRAP_TX_LABEL],
    'bootstrap-tx-01',
  );
  guard(bootstrap);
});

test('same-image rebuild pins only a lowercase sha256 immutable image id', () => {
  const imageId = `sha256:${'a'.repeat(64)}`;
  const rebuilt = buildCreateOptions(spec(), {
    network: 'tle-net', imageRepo: 'nodered/node-red',
    instanceDataRoot: DATA_ROOT, timezone: 'Asia/Shanghai',
    imageIdOverride: imageId,
  });
  assert.equal(rebuilt['Image'], imageId);
  guard(rebuilt);

  for (const bad of [
    'sha256:short',
    `sha256:${'A'.repeat(64)}`,
    `nodered/node-red:${'a'.repeat(64)}`,
    `${'a'.repeat(64)}`,
  ]) {
    assert.throws(() => buildCreateOptions(spec(), {
      network: 'tle-net', imageRepo: 'nodered/node-red',
      instanceDataRoot: DATA_ROOT, timezone: 'Asia/Shanghai',
      imageIdOverride: bad,
    }), SpecError, bad);
  }
});

test('stopped migration probe has deterministic tx ownership, immutable image, and no host port', () => {
  const txId = 'migration-tx-01';
  const imageId = `sha256:${'c'.repeat(64)}`;
  const options = buildMigrationProbeCreateOptions(spec(), {
    instanceDataRoot: DATA_ROOT,
    imageRepo: 'nodered/node-red',
    timezone: 'Asia/Shanghai',
    txId,
    imageId,
    networkId: 'probe-network-immutable-id',
  });
  const labels = options['Labels'] as Record<string, unknown>;
  const host = options['HostConfig'] as Record<string, unknown>;
  assert.equal(options['name'], migrationProbeName('line-a', txId));
  assert.equal(options['Image'], imageId);
  assert.equal(labels[MIGRATION_TX_LABEL], txId);
  assert.equal(labels[MIGRATION_PROBE_LABEL], 'true');
  assert.deepEqual(host['Binds'], [`${migrationProbeDataDir(DATA_ROOT, 'line-a', txId)}:/data`]);
  assert.equal(host['NetworkMode'], 'probe-network-immutable-id');
  assert.deepEqual(host['PortBindings'], {});
  assert.deepEqual(options['ExposedPorts'], {});
  assertSafeMigrationProbeOptions(options, { instanceDataRoot: DATA_ROOT, instanceId: 'line-a', txId });
  assert.notEqual(migrationProbeNetworkName('line-a', txId), migrationProbeName('line-a', txId));
});

test('probe spec rejects path/tx/image tampering and an injected host port', () => {
  const txId = 'migration-tx-01';
  const options = buildMigrationProbeCreateOptions(spec(), {
    instanceDataRoot: DATA_ROOT,
    imageRepo: 'nodered/node-red',
    timezone: 'Asia/Shanghai',
    txId,
    imageId: `sha256:${'d'.repeat(64)}`,
    networkId: 'probe-network-immutable-id',
  });
  ((options['HostConfig'] as Record<string, unknown>)['PortBindings'] as Record<string, unknown>)['1880/tcp'] = [
    { HostIp: '0.0.0.0', HostPort: '1880' },
  ];
  assert.throws(
    () => assertSafeMigrationProbeOptions(options, {
      instanceDataRoot: DATA_ROOT, instanceId: 'line-a', txId,
    }),
    SpecError,
  );
  assert.throws(() => migrationProbeDataDir(DATA_ROOT, 'line-a', '../escape'), SpecError);
});

test('1880 绝不映射宿主 —— 唯一入口必须是 Manager 反代', () => {
  const o = build(spec());
  const pb = (o['HostConfig'] as Record<string, unknown>)['PortBindings'] as Record<string, unknown>;
  assert.ok(!Object.keys(pb).some((k) => k.startsWith('1880/')));

  const tampered = build(spec());
  ((tampered['HostConfig'] as Record<string, unknown>)['PortBindings'] as Record<string, unknown>)['1880/tcp'] =
    [{ HostIp: '0.0.0.0', HostPort: '1880' }];
  assert.throws(() => guard(tampered), SpecError);
});

test('六类提权参数被二次校验拦截', () => {
  const cases: Array<[string, (hc: Record<string, unknown>) => void]> = [
    ['Privileged', (hc) => { hc['Privileged'] = true; }],
    ['任意 bind 挂宿主根', (hc) => { hc['Binds'] = ['/:/host']; }],
    ['借 ../ 跳出数据根', (hc) => { hc['Binds'] = [`${DATA_ROOT}/../../../etc:/data`]; }],
    ['挂到别的实例目录', (hc) => { hc['Binds'] = [`${DATA_ROOT}/line-b:/data`]; }],
    ['多加一条合法之外的挂载', (hc) => { hc['Binds'] = [`${DATA_ROOT}/line-a:/data`, '/etc:/etc']; }],
    ['host 网络', (hc) => { hc['NetworkMode'] = 'host'; }],
    ['host PID', (hc) => { hc['PidMode'] = 'host'; }],
    ['CapAdd', (hc) => { hc['CapAdd'] = ['SYS_ADMIN']; }],
    ['挂载 docker socket', (hc) => { hc['Binds'] = ['/var/run/docker.sock:/var/run/docker.sock']; }],
  ];
  for (const [name, mutate] of cases) {
    const o = build(spec());
    mutate(o['HostConfig'] as Record<string, unknown>);
    assert.throws(() => guard(o), SpecError, `应拦截：${name}`);
  }
});

test('关闭只读根或改回 root 运行会被拦截', () => {
  const a = build(spec());
  (a['HostConfig'] as Record<string, unknown>)['ReadonlyRootfs'] = false;
  assert.throws(() => guard(a), SpecError);

  const b = build(spec());
  b['User'] = 'root';
  assert.throws(() => guard(b), SpecError);
});

test('容器时区必须显式给定，缺失或非法一律拦下', () => {
  // 正常路径：模板注入宿主配置的时区
  const o = build(spec());
  assert.ok((o['Env'] as string[]).includes('TZ=Asia/Shanghai'), JSON.stringify(o['Env']));

  // 漏传 timezone 时模板生成 TZ=undefined —— 容器会静默退回 UTC，必须在下发前拦住。
  // 类型系统管不到这里：测试文件被 tsconfig 排除，不参与类型检查
  const missing = buildCreateOptions(spec(), {
    network: 'tle-net', imageRepo: 'nodered/node-red', instanceDataRoot: DATA_ROOT,
  } as unknown as Parameters<typeof buildCreateOptions>[1]);
  assert.throws(() => guard(missing), SpecError, '应拦截 TZ=undefined');

  for (const bad of ['TZ=', 'TZ=../etc/passwd', 'TZ=Asia Shanghai', 'TZ=;rm -rf /']) {
    const t = build(spec());
    t['Env'] = [bad, ...(t['Env'] as string[]).slice(1)];
    assert.throws(() => guard(t), SpecError, `应拦截 ${bad}`);
  }
});

test('容器名与数据目录按实例 id 派生', () => {
  assert.equal(containerName('line-a'), 'tle-nr-line-a');
  assert.equal(instanceDataDir(DATA_ROOT, 'line-a'), `${DATA_ROOT}/line-a`);
});

test('未知 Docker 配置与旁路挂载无法突破固定创建模板', () => {
  for (const [key, value] of [
    ['Mounts', [{ Type: 'bind', Source: '/', Target: '/host' }]],
    ['Volumes', { '/etc': {} }],
    ['NetworkingConfig', { EndpointsConfig: { 'other-instance': {} } }],
    ['Entrypoint', ['/bin/sh']],
  ] as const) {
    const options = build(spec());
    options[key] = value;
    assert.throws(() => guard(options), SpecError, key);
  }
  for (const [key, value] of [
    ['Mounts', [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/socket' }]],
    ['VolumesFrom', ['other-instance']],
    ['PidMode', 'container:other-instance'],
    ['IpcMode', 'container:other-instance'],
    ['UTSMode', 'host'],
    ['CgroupnsMode', 'host'],
    ['UsernsMode', 'host'],
    ['DeviceRequests', [{ Count: -1, Capabilities: [['gpu']] }]],
    ['Links', ['other-instance']],
    ['GroupAdd', ['0']],
    ['ExtraHosts', ['host.docker.internal:host-gateway']],
  ] as const) {
    const options = build(spec());
    (options['HostConfig'] as Record<string, unknown>)[key] = value;
    assert.throws(() => guard(options), SpecError, key);
  }
});

test('设备实例不得共享宿主、其他容器或其他实例网络', () => {
  for (const network of ['host', 'bridge', 'default', 'none', 'container:tle-nr-line-b', 'tle-net-line-b']) {
    const options = build(spec());
    (options['HostConfig'] as Record<string, unknown>)['NetworkMode'] = network;
    assert.throws(() => guard(options), SpecError, network);
  }
});

test('权限与资源限制不能被移除、放大或用其他参数替代', () => {
  for (const [key, value] of [
    ['CapDrop', undefined], ['CapDrop', []],
    ['SecurityOpt', []], ['SecurityOpt', ['no-new-privileges:true', 'seccomp=unconfined']],
    ['Memory', 0], ['Memory', 128 * 1024 ** 3],
    ['MemorySwap', -1], ['NanoCpus', 0], ['PidsLimit', -1],
    ['LogConfig', { Type: 'json-file', Config: {} }],
    ['LogConfig', { Type: 'syslog', Config: { 'syslog-address': 'tcp://other-instance:514' } }],
    ['Tmpfs', { '/tmp': 'rw,exec,suid,size=64m' }],
    ['Tmpfs', { '/tmp': 'rw,noexec,nosuid,size=64m', '/etc': 'rw' }],
    ['Sysctls', { 'net.ipv6.conf.all.disable_ipv6': '0' }],
    ['Binds', undefined], ['Binds', []], ['Binds', [`${DATA_ROOT}/line-a:/data`, `${DATA_ROOT}/line-a:/data`]],
  ] as const) {
    const options = build(spec());
    const host = options['HostConfig'] as Record<string, unknown>;
    if (value === undefined) delete host[key]; else host[key] = value;
    assert.throws(() => guard(options), SpecError, key);
  }
  const options = build(spec());
  options['User'] = 'node-red';
  assert.throws(() => guard(options), SpecError, '用户名可能在镜像中映射为 root');
});

test('bootstrap cannot be replaced or injected through Node startup environment', () => {
  for (const [key, value] of [['Entrypoint', ['/bin/sh']], ['Cmd', ['--eval', 'process.exit(0)']]] as const) {
    const options = build(spec()); options[key] = value;
    assert.throws(() => guard(options), SpecError);
  }
  for (const entry of ['NODE_OPTIONS=--require=/data/attack.js', 'LD_PRELOAD=/data/attack.so', 'BASH_ENV=/data/attack.sh']) {
    const options = build(spec());
    options['Env'] = [...options['Env'] as string[], entry];
    assert.throws(() => guard(options), SpecError);
  }
});

test('标签、容器名与受管数据路径必须属于同一实例', () => {
  for (const mutate of [
    (options: Record<string, unknown>) => { options['name'] = 'tle-nr-line-b'; },
    (options: Record<string, unknown>) => {
      (options['Labels'] as Record<string, unknown>)['com.mqttsnet.thinglinks-edge.managed'] = 'false';
    },
  ]) {
    const options = build(spec()); mutate(options);
    assert.throws(() => guard(options), SpecError);
  }
  for (const root of ['/', '/etc', '/etc/shadow', '/var/run', '/proc', '/sys', '/dev', './instances', '/tmp/a/../../etc']) {
    const options = buildCreateOptions(spec(), {
      network: 'tle-net', imageRepo: 'nodered/node-red', instanceDataRoot: root, timezone: 'UTC',
    });
    assert.throws(() => assertSafeCreateOptions(options, { instanceDataRoot: root }), SpecError, root);
  }
});

test('迁移 probe 不能利用独立创建入口绕过能力、命名空间、资源限制', () => {
  for (const [key, value] of [
    ['NetworkMode', 'container:tle-nr-line-a'], ['PidMode', 'container:tle-nr-line-a'],
    ['CapDrop', []], ['SecurityOpt', []], ['MemorySwap', -1], ['PidsLimit', 0],
    ['LogConfig', { Type: 'json-file', Config: {} }],
  ] as const) {
    const options = buildMigrationProbeCreateOptions(spec(), {
      instanceDataRoot: DATA_ROOT, imageRepo: 'nodered/node-red', timezone: 'UTC',
      txId: 'migration-tx-01', imageId: `sha256:${'e'.repeat(64)}`, networkId: 'probe-network-id',
    });
    (options['HostConfig'] as Record<string, unknown>)[key] = value;
    assert.throws(() => assertSafeMigrationProbeOptions(options, {
      instanceDataRoot: DATA_ROOT, instanceId: 'line-a', txId: 'migration-tx-01', expectedNetwork: 'probe-network-id',
    }), SpecError, key);
  }
});
