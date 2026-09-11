import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { controlWriteScript, type ControlWriteOptions } from './control-codec.ts';

const point = (dataType = 'uint16be', source = '3') => ({
  property: 'speed',
  source,
  dataType,
  scale: 1,
  offset: 0,
});
const options = (over: Partial<ControlWriteOptions> = {}): ControlWriteOptions => ({
  nodeId: 'device-1',
  serviceCode: 'motor',
  points: [point()],
  mappings: [{ cmd: 'setSpeed', param: 'value', property: 'speed' }],
  address: 100,
  unitId: 1,
  ...over,
});
const command = (params: unknown = { value: 12 }, over: Record<string, unknown> = {}) => ({
  id: 'command-1',
  leaseToken: 'lease-1',
  mid: 100,
  deviceIdentification: 'device-1',
  serviceCode: 'motor',
  cmd: 'setSpeed',
  params,
  ...over,
});
function execute(
  protocol: string,
  config = options(),
  value: unknown = command(),
  extra: Record<string, unknown> = {},
) {
  const errors: string[] = [];
  const msg: Record<string, any> = { ...extra, payload: { command: value } };
  const context = { msg, Buffer, URL, node: { error: (message: string) => errors.push(message) } };
  const result = runInNewContext(`(function(){${controlWriteScript(protocol, config)}\n})()`, context, {
    timeout: 1000,
  });
  return { result: result === null ? null : JSON.parse(JSON.stringify(result)), errors, msg, context };
}

test('empty lease poll does not send or report an error; command correlation survives validation failures', () => {
  assert.deepEqual(execute('modbus-tcp', options(), null).errors, []);
  assert.equal(execute('modbus-tcp', options(), null).result, null);
  const bad = execute(
    'modbus-tcp',
    options(),
    command({ value: 1 }, { deviceIdentification: 'another-device' }),
  );
  assert.equal(bad.result, null);
  assert.deepEqual(JSON.parse(JSON.stringify(bad.msg._tleCommand)), {
    id: 'command-1',
    leaseToken: 'lease-1',
  });
  assert.equal(bad.errors.length, 1);
});

test('Modbus writes use real flex-write value/fc/unitid/address/quantity contract and inverse scaling', () => {
  const actual = execute(
    'modbus-tcp',
    options({ points: [{ ...point('float32be'), scale: 2, offset: 10 }] }),
    command({ value: 35 }),
  );
  assert.deepEqual(actual.result.payload, {
    value: [0x4148, 0],
    fc: 16,
    unitid: 1,
    address: 103,
    quantity: 2,
  });
  assert.equal(actual.result._tleCommand.id, 'command-1');
  assert.equal(actual.errors.length, 0);
});

test('Modbus signed integers and ABCD/DCBA/CDAB layouts are encoded as unsigned register words', () => {
  const examples: [string, number, number | number[]][] = [
    ['uint16be', 0x1234, 0x1234],
    ['uint16le', 0x1234, 0x3412],
    ['int16be', -2, 65534],
    ['int16le', -2, 0xfeff],
    ['uint32be', 0x12345678, [0x1234, 0x5678]],
    ['uint32le', 0x12345678, [0x7856, 0x3412]],
    ['uint32swap', 0x12345678, [0x5678, 0x1234]],
    ['int32be', -2, [65535, 65534]],
    ['int32swap', -2, [65534, 65535]],
    ['float32be', 12.5, [0x4148, 0]],
    ['float32le', 12.5, [0, 0x4841]],
    ['float32swap', 12.5, [0, 0x4148]],
  ];
  for (const [kind, value, expected] of examples) {
    const actual = execute('modbus-tcp', options({ points: [point(kind)] }), command({ value }));
    assert.deepEqual(actual.result?.payload.value, expected, kind);
    assert.equal(actual.result.payload.fc, Array.isArray(expected) ? 16 : 6);
  }
});

test('integer ranges, float overflow, zero scales, fractional register values and address overflow fail closed', () => {
  for (const [kind, value] of [
    ['uint16be', 65536],
    ['int16be', -32769],
    ['uint32be', 4294967296],
    ['int32be', 2147483648],
    ['uint16be', 1.5],
    ['float32be', Number.MAX_VALUE],
    ['float32be', NaN],
    ['float32be', Infinity],
    ['float32be', 1e-50],
    ['uint32be', Number.MAX_SAFE_INTEGER + 1],
  ] as [string, number][]) {
    assert.equal(
      execute('modbus-tcp', options({ points: [point(kind)] }), command({ value })).result,
      null,
      kind,
    );
  }
  for (const scale of [0, NaN, Infinity])
    assert.equal(execute('modbus-tcp', options({ points: [{ ...point(), scale }] })).result, null);
  assert.equal(
    execute('modbus-tcp', options({ points: [point('uint32be', '65535')], address: 0 })).result,
    null,
  );
  assert.equal(execute('modbus-tcp', options({ unitId: 0 })).result, null);
});

test('commands require exact device/service/cmd and one declared parameter with a unique property mapping', () => {
  for (const invalid of [
    command({ value: 1 }, { serviceCode: 'other' }),
    command({ value: 1 }, { cmd: 'unknown' }),
    command({ value: 1, extra: 2 }),
    command({}),
    command([]),
    command(null),
    command({ value: null }),
    command({ value: '12' }),
    command({ value: 1 }, { id: '' }),
    command({ value: 1 }, { leaseToken: '' }),
    undefined,
  ]) {
    // Pass an explicit message for undefined rather than the helper default.
    const c = invalid === undefined ? { ...command(), params: undefined } : invalid;
    const actual = execute('modbus-tcp', options(), c);
    assert.equal(actual.result, null);
    assert.equal(actual.errors.length, 1);
  }
  const duplicate = { cmd: 'setSpeed', param: 'value', property: 'speed' };
  assert.equal(execute('modbus-tcp', options({ mappings: [duplicate, duplicate] })).result, null);
  assert.equal(execute('modbus-tcp', options({ points: [point(), point()] })).result, null);
  assert.equal(
    execute('modbus-tcp', options({ nodeId: '' }), command({ value: 1 }, { deviceIdentification: '' }))
      .result,
    null,
  );
  assert.equal(
    execute('modbus-tcp', options({ serviceCode: '' }), command({ value: 1 }, { serviceCode: '' })).result,
    null,
  );
});

test('OPC UA scalar topics and S7 configured variable names preserve types and reverse scale', () => {
  const ua = execute(
    'opcua',
    options({ points: [{ ...point('Double', 'ns=2;s=Speed'), scale: 2, offset: 4 }] }),
    command({ value: 10 }),
  );
  assert.equal(ua.result.topic, 'ns=2;s=Speed;datatype=Double');
  assert.equal(ua.result.payload, 3);
  const s7 = execute(
    's7',
    options({ points: [{ ...point('number', 'DB1,REAL0'), scale: 2, offset: 4 }] }),
    command({ value: 10 }),
  );
  assert.equal(s7.result.variable, 'speed');
  assert.equal(s7.result.payload, 3);
  assert.equal(
    execute('opcua', options({ points: [point('UInt16', 'ns=2;s=Speed')] }), command({ value: 65536 }))
      .result,
    null,
  );
  for (const [type, good, bad] of [
    ['Boolean', true, 'true'],
    ['String', 'ready', true],
  ] as [string, unknown, unknown][]) {
    assert.equal(
      execute('opcua', options({ points: [point(type, 'ns=2;s=Speed')] }), command({ value: good })).result
        .payload,
      good,
    );
    assert.equal(
      execute('opcua', options({ points: [point(type, 'ns=2;s=Speed')] }), command({ value: bad })).result,
      null,
    );
  }
});

test('S7 numeric control is bounded by the actual PLC address type, including I/Q/M scalar addresses', () => {
  const write = (source: string, value: unknown, type = 'number') =>
    execute('s7', options({ points: [point(type, source)] }), command({ value }));
  for (const [source, value] of [
    ['DB1,INT4', 32768],
    ['DB1,INT4', 1.5],
    ['DB1,WORD4', -1],
    ['DB1,DINT4', 2147483648],
    ['DB1,DWORD4', 4294967296],
    ['DB1,BYTE4', 256],
    ['DB1,REAL0', 1e100],
    ['DB1,REAL0', 1e-50],
    ['MI2', 32768],
    ['MW2', 65536],
    ['MR0', 1e-50],
  ] as [string, number][]) {
    assert.equal(write(source, value).result, null, source);
  }
  for (const [source, value] of [
    ['DB1,REAL0', 12.5],
    ['DB1,INT4', -32768],
    ['DB1,WORD4', 65535],
    ['DB1,DINT4', -2147483648],
    ['DB1,DWORD4', 4294967295],
    ['IB0', 255],
    ['QW2', 65535],
    ['MI2', -1],
    ['MDI4', -2],
    ['MDW4', 4294967295],
    ['MR0', 12.5],
  ] as [string, number][]) {
    assert.equal(write(source, value).result?.payload, value, source);
  }
  for (const source of ['DB1,LREAL0', 'DB1,INT0.2', 'DB0,INT0', 'DB1,REAL65534', 'UNKNOWN0', 'MX0.1']) {
    assert.equal(write(source, 1).result, null, source);
  }
});

test('S7 bit and bounded ASCII string targets never coerce values or silently truncate text', () => {
  const write = (source: string, value: unknown, type: string) =>
    execute('s7', options({ points: [point(type, source)] }), command({ value }));
  for (const source of ['DB1,X0.1', 'I0.0', 'Q0.7', 'M4.3'])
    assert.equal(write(source, true, 'boolean').result?.payload, true, source);
  for (const [source, value, type] of [
    ['DB1,X0.8', true, 'boolean'],
    ['DB1,X0', true, 'boolean'],
    ['DB1,X0.1', 1, 'number'],
    ['DB1,INT0', true, 'boolean'],
    ['DB1,INT0', '1', 'string'],
  ]) {
    assert.equal(write(source as string, value, type as string).result, null, source as string);
  }
  assert.equal(write('DB1,STRING0.8', '12345678', 'string').result?.payload, '12345678');
  assert.equal(write('DB1,CHAR2', 'A', 'string').result?.payload, 'A');
  for (const [source, value] of [
    ['DB1,STRING0.8', '123456789'],
    ['DB1,STRING0.8', '中文'],
    ['DB1,STRING0', 'text'],
    ['DB1,STRING0.255', 'text'],
    ['DB1,STRING65535.2', 'ok'],
    ['DB1,CHAR2', 'AB'],
    ['DB1,CHAR2', ''],
  ]) {
    assert.equal(write(source!, value, 'string').result, null, source);
  }
});

test('HTTP constructs safe JSON paths and strips every previous-hop credential and URL override', () => {
  const actual = execute(
    'http',
    options({ commandUrl: 'https://device.example/control', points: [point('number', 'motor.speed')] }),
    command({ value: 9 }),
    {
      headers: { authorization: 'manager-secret' },
      _headers: { cookie: 'manager-secret' },
      _requestHeaders: { authorization: 'manager-secret' },
      cookies: { sid: 'manager-secret' },
      auth: 'manager-secret',
      authorization: 'manager-secret',
      url: 'http://manager/commands',
      responseUrl: 'http://manager',
      proxy: 'http://manager-secret',
      req: { headers: { authorization: 'manager-secret' } },
      res: { secret: 'manager-secret' },
    },
  );
  assert.equal(actual.result.method, 'POST');
  assert.equal(actual.result.url, 'https://device.example/control');
  assert.deepEqual(actual.result.headers, { 'content-type': 'application/json' });
  assert.deepEqual(actual.result.payload, { motor: { speed: 9 } });
  assert.doesNotMatch(JSON.stringify(actual.result), /manager-secret|http:\/\/manager/);
  for (const source of ['__proto__.polluted', 'motor.constructor.x', 'motor..speed']) {
    assert.equal(
      execute('http', options({ commandUrl: 'http://device/control', points: [point('number', source)] }))
        .result,
      null,
    );
  }
  for (const commandUrl of [
    'file:///etc/passwd',
    'https://u:p@device/control',
    'http://device/control#secret',
  ]) {
    assert.equal(execute('http', options({ commandUrl, points: [point('number', 'speed')] })).result, null);
  }
});

test('TCP/UDP emit only the agreed JSON request and never leak a lease or claim an acknowledgement', () => {
  for (const protocol of ['tcp', 'udp']) {
    const actual = execute(
      protocol,
      options({ points: [point('boolean', 'enabled')] }),
      command({ value: true }),
    );
    assert.deepEqual(JSON.parse(actual.result.payload), {
      requestId: 'command-1',
      cmd: 'setSpeed',
      params: { enabled: true },
    });
    assert.doesNotMatch(actual.result.payload, /leaseToken|lease-1/);
    assert.equal(actual.result.ok, undefined);
  }
});

test('configuration text cannot become executable code and unsafe parameter names are rejected', () => {
  const source = 'x";globalThis.injected=true;//';
  const actual = execute(
    'tcp',
    options({ points: [point('string', source)] }),
    command({ value: 'literal' }),
  );
  assert.equal(JSON.parse(actual.result.payload).params[source], 'literal');
  assert.equal((actual.context as Record<string, unknown>).injected, undefined);
  assert.equal(execute('tcp', options(), command(JSON.parse('{"__proto__":12}'))).result, null);
  assert.equal(execute('unknown', options()).result, null);
});
