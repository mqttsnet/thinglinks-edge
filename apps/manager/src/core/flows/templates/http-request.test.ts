import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { httpPollRecipe, httpReceiveRecipe } from './builtin/http.ts';
import type { FlowNode } from '../types.ts';

const parameters = {
  nodeId: 'site-device',
  serviceCode: 'telemetry',
  url: 'http://device/data',
  interval: 0.1,
  path: '/device/report',
  points: [{ source: 'temperature', property: 'temperature', dataType: 'number', scale: 1, offset: 0 }],
};
function fixture() {
  const nodes = httpPollRecipe.build(parameters);
  const shared = new Map<string, unknown>();
  const local = new Map<string, Map<string, unknown>>();
  const errors: string[] = [];
  let now = 1_000;
  return {
    nodes,
    errors,
    advance(ms: number) {
      now += ms;
    },
    execute(id: string, msg: Record<string, unknown>, runtimeId = id): Record<string, unknown> | null {
      const config = nodes.find((node) => node.id === id);
      assert.equal(config?.type, 'function', `${id} must run a real generated Function node`);
      const context = local.get(runtimeId) ?? new Map<string, unknown>();
      local.set(runtimeId, context);
      return runInNewContext(`(function(msg,node,flow,context){${config!.func}})(msg,node,flow,context)`, {
        msg,
        Buffer,
        Date: { now: () => now },
        node: { id: runtimeId, error: (message: string) => errors.push(message) },
        flow: {
          get: (key: string) => shared.get(key),
          set: (key: string, value: unknown) => shared.set(key, value),
        },
        context: {
          get: (key: string) => context.get(key),
          set: (key: string, value: unknown) => context.set(key, value),
        },
      });
    },
  };
}
const outgoing = (node: FlowNode | undefined) => (node?.wires as string[][] | undefined)?.[0] ?? [];

test('HTTP polling sends a real message timeout and keeps only one pending request per template', () => {
  const f = fixture();
  assert.deepEqual(outgoing(f.nodes.find((n) => n.id === 'poll')), ['http-start']);
  assert.deepEqual(outgoing(f.nodes.find((n) => n.id === 'http-start')), ['request']);
  const first = f.execute('http-start', { payload: '' });
  assert.ok(first);
  assert.equal(
    first.requestTimeout,
    10_000,
    'the driver reads msg.requestTimeout, not a node config property',
  );
  assert.equal(f.execute('http-start', { payload: '' }), null);
  assert.equal(
    f.execute('http-status', { ...first, statusCode: 200, payload: { temperature: 25 } })?.statusCode,
    200,
  );
  assert.ok(
    f.execute('http-start', { payload: '' }),
    'a completed request releases the next scheduled sample',
  );
});

test('HTTP error responses and catch events release the request without forwarding invalid readings', () => {
  const f = fixture();
  const first = f.execute('http-start', { payload: '' });
  assert.ok(first);
  assert.equal(f.execute('http-status', { ...first, statusCode: 503, payload: { temperature: 0 } }), null);
  assert.equal(f.errors.length, 1);
  const second = f.execute('http-start', { payload: '' });
  assert.ok(second);
  assert.deepEqual(outgoing(f.nodes.find((n) => n.id === 'errors')), ['http-release-error']);
  assert.deepEqual(outgoing(f.nodes.find((n) => n.id === 'http-release-error')), ['error-log']);
  const failure = { ...second, error: { message: 'ETIMEDOUT' } };
  assert.ok(f.execute('http-release-error', failure));
  assert.ok(f.execute('http-start', { payload: '' }));
});

test('HTTP pending state has bounded lifetime and stale callbacks cannot release a newer request', () => {
  const f = fixture();
  const first = f.execute('http-start', { payload: '' });
  assert.ok(first);
  for (let i = 0; i < 100; i++) {
    f.advance(100);
    assert.equal(f.execute('http-start', { payload: '' }), null);
  }
  f.advance(6_000);
  const next = f.execute('http-start', { payload: '' });
  assert.ok(next, 'a lost callback cannot permanently stop polling');
  assert.equal(f.execute('http-status', { ...first, statusCode: 200, payload: { temperature: 10 } }), null);
  f.execute('http-release-error', { ...first, error: { message: 'late error' } });
  assert.equal(
    f.execute('http-start', { payload: '' }),
    null,
    'late callbacks must not release the current request',
  );
  assert.ok(f.execute('http-status', { ...next, statusCode: 200, payload: { temperature: 25 } }));
  assert.ok(f.execute('http-start', { payload: '' }));
});

test('separate appended polling templates isolate pending state by the runtime node id', () => {
  const f = fixture();
  const a = f.execute('http-start', { payload: '' }, 'copy-a');
  const b = f.execute('http-start', { payload: '' }, 'copy-b');
  assert.ok(a);
  assert.ok(b);
  f.execute('http-status', { ...a, statusCode: 200 });
  assert.ok(f.execute('http-start', { payload: '' }, 'copy-a'));
  assert.equal(f.execute('http-start', { payload: '' }, 'copy-b'), null);
});

test('HTTP receive keeps its asynchronous 202 response after successful parsing', () => {
  const nodes = httpReceiveRecipe.build(parameters);
  assert.deepEqual(outgoing(nodes.find((n) => n.id === 'decode')), ['device', 'ack']);
  const ack = nodes.find((n) => n.id === 'ack')!;
  const response = runInNewContext(`(function(msg){${ack.func}})({})`);
  assert.equal(response.statusCode, 202);
  assert.equal(response.payload.delivery, 'asynchronous');
});
