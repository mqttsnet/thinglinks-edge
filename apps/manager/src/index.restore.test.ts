import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRestoreWritersStopped } from './index.ts';

const config = { instanceDataRoot: '/srv/test/instances', portRange: { min: 30000, max: 30999 }, timezone: 'UTC' };
const snapshot = (state: string, stopped = false) => ({ version: 1, instanceDataRoot: config.instanceDataRoot,
  writers: [{ id: 'a'.repeat(64), name: '/test-instance', state, stopped }] });
for (const state of ['running', 'paused', 'restarting', 'dead', 'unknown']) {
  test(`restore gate refuses ${state} writers`, async () => {
    await assert.rejects(() => assertRestoreWritersStopped(config, async () => snapshot(state)), /停止|写入者/);
  });
}
test('restore gate accepts an authenticated snapshot containing only exited or created writers', async () => {
  await assertRestoreWritersStopped(config, async () => snapshot('exited', true));
  await assertRestoreWritersStopped(config, async () => snapshot('created', true));
});
test('restore gate fails closed on incomplete, foreign or unavailable policy evidence', async () => {
  for (const invalid of [{}, { ...snapshot('exited', true), instanceDataRoot: '/other' }, snapshot('paused', true),
    { version: 1, instanceDataRoot: config.instanceDataRoot, writers: null }]) {
    await assert.rejects(() => assertRestoreWritersStopped(config, async () => invalid));
  }
  await assert.rejects(() => assertRestoreWritersStopped(config, async () => { throw new Error('unavailable'); }), /拒绝恢复/);
});

test('direct daemon restore is explicitly refused rather than bypassing the writer gate', async t => {
  const previous = process.env['DOCKER_HOST'];
  t.after(() => { if (previous === undefined) delete process.env['DOCKER_HOST']; else process.env['DOCKER_HOST'] = previous; });
  process.env['DOCKER_HOST'] = 'unix:///var/run/docker.sock';
  await assert.rejects(() => assertRestoreWritersStopped(config), /恢复须通过部署的 Docker 策略代理/);
});
