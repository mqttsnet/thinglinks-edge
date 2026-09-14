import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { renderBuiltinTemplate } from './catalog.ts';
import { controlWriteScript } from './control-codec.ts';

const network = ['builtin:tcp', 'builtin:udp', 'builtin:http-poll', 'builtin:http-receive'];
function pointsFor(id: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    source: id.includes('opcua') ? `ns=2;s=Value${i}` : id === 'builtin:s7' ? `DB1,WORD${i * 2}` : `value${i}`,
    property: `p${i}`, dataType: id.includes('opcua') ? 'Double' : 'number', scale: 2, offset: 1,
  }));
}
for (const id of [...network, 'builtin:s7', 'builtin:opcua', 'builtin:opcua-controlled']) {
  test(`${id} retains all 300 configured points and rejects point 301`, () => {
    const input = { nodeId: 'points-device', serviceCode: 'telemetry',
      ...(id === 'builtin:s7' ? { host: '192.0.2.10' } : {}),
      ...(id === 'builtin:http-poll' ? { url: 'http://192.0.2.10/data' } : {}),
      ...(id.includes('opcua') ? { endpoint: 'opc.tcp://192.0.2.10:4840' } : {}),
      points: pointsFor(id, 300),
    };
    const result = renderBuiltinTemplate(id, input)!;
    assert.equal(result.parameters!.find(p => p.key === 'points')!.max, 300);
    assert.equal((result.parameterValues!.points as unknown[]).length, 300);
    assert.throws(() => renderBuiltinTemplate(id, { ...input, points: pointsFor(id, 301) }), /300/);
    if (network.includes(id) || id === 'builtin:s7') {
      const data = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [id === 'builtin:s7' ? `raw_${i}` : `value${i}`, i]));
      const errors: string[] = [];
      const mapped = runInNewContext(`(function(){${result.flows.find(n => n.id === 'decode')!.func}})()`, {
        Buffer, msg: { payload: data }, node: { error: (value: string) => errors.push(value) },
      }, { timeout: 1000 });
      assert.deepEqual(errors, []);
      assert.equal(Object.keys(mapped.payload).length, 300);
      assert.equal(mapped.payload.p299, 599);
    }
  });
}

test('control can target point 300 while the separate 64-command mapping limit is preserved', () => {
  const points = pointsFor('builtin:tcp', 300);
  const mapping = { cmd: 'setValue', param: 'value', property: 'p299' };
  const options = { nodeId: 'points-device', serviceCode: 'telemetry', points, mappings: [mapping] };
  const execute = (mappings = options.mappings, configuredPoints = points) => {
    const errors: string[] = [];
    const result = runInNewContext(`(function(){${controlWriteScript('tcp', { ...options, mappings, points: configuredPoints })}})()`, {
      Buffer, URL, msg: { payload: { command: { id: 'command-300', leaseToken: 'lease-300', deviceIdentification: 'points-device', serviceCode: 'telemetry', cmd: 'setValue', params: { value: 41 } } } },
      node: { error: (message: string) => errors.push(message) },
    }, { timeout: 1000 });
    return { result, errors };
  };
  const accepted = execute(); assert.deepEqual(accepted.errors, []);
  assert.equal(JSON.parse(accepted.result.payload).params.value299, 20);
  assert.equal(execute(Array.from({ length: 65 }, () => mapping)).result, null);
  assert.equal(execute([mapping], pointsFor('builtin:tcp', 301)).result, null);
});
