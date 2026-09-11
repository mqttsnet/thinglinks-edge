import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileInstanceNetworks } from './network-reconcile.ts';

test('超时会 abort 挂起恢复，且不阻塞健康实例', async () => {
  const events: string[] = [];
  let aborted = false;
  let lateMutation = false;
  const results = await reconcileInstanceNetworks(
    ['hung', 'healthy'],
    (id, signal) => {
      if (id === 'healthy') {
        events.push('healthy-start');
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const delayedMutation = setTimeout(() => {
          lateMutation = true;
          resolve();
        }, 60);
        signal.addEventListener('abort', () => {
          aborted = true;
          events.push('hung-aborted');
          clearTimeout(delayedMutation);
          reject(signal.reason);
        }, { once: true });
      });
    },
    20,
  );

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { id: 'hung', ok: false, error: '20ms 内未完成网络恢复' });
  assert.deepEqual(results[1], { id: 'healthy', ok: true });
  assert.ok(events.indexOf('healthy-start') < events.indexOf('hung-aborted'), '健康实例应先启动恢复');
  assert.equal(aborted, true, '超时时必须 abort 挂起请求');
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(lateMutation, false, 'abort 后不得发生迟到的网络变更');
});
