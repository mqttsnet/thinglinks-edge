import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { framingScript } from './framing.ts';

function fixture(mode: 'newline' | 'fixed', length = 4) {
  const store = new Map<string, unknown>();
  const sent: Buffer[] = [];
  const errors: string[] = [];
  const script = `(function(msg,node,context){${framingScript(mode, length)}})(msg,node,context)`;
  return {
    sent,
    errors,
    input(payload: string, session = 'a') {
      runInNewContext(script, {
        msg: { payload: Buffer.from(payload), _session: { id: session } },
        Buffer,
        context: {
          get: (key: string) => store.get(key),
          set: (key: string, v: unknown) => store.set(key, v),
        },
        node: {
          send: (msg: { payload: Buffer }) => sent.push(msg.payload),
          error: (e: string) => errors.push(e),
        },
      });
    },
  };
}
test('TCP newline framing isolates sessions and reassembles split and coalesced frames', () => {
  const f = fixture('newline');
  f.input('a');
  f.input('b\n', 'b');
  f.input('c\nd\n');
  assert.deepEqual(
    f.sent.map((b) => b.toString()),
    ['b', 'ac', 'd'],
  );
});
test('fixed-length frames preserve bytes across incoming chunks', () => {
  const f = fixture('fixed');
  f.input('ab');
  f.input('cdefghij');
  f.input('kl');
  assert.deepEqual(
    f.sent.map((b) => b.toString()),
    ['abcd', 'efgh', 'ijkl'],
  );
});
test('oversized unterminated frame is rejected without forwarding', () => {
  const f = fixture('newline');
  f.input('x'.repeat(65537));
  assert.equal(f.sent.length, 0);
  assert.equal(f.errors.length, 1);
});
