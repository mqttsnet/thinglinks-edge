import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demuxDockerLog, dockerLogToText } from './log-stream.ts';

/** 造一个 Docker 多路复用帧：8 字节头 + 载荷 */
function frame(stream: 0 | 1 | 2, payload: string | Buffer): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, data]);
}

test('帧头不出现在正文里', () => {
  // 实测字节：0100 0000 0000 000d "HELLO-STDOUT\n"
  const buf = Buffer.concat([frame(1, 'HELLO-STDOUT\n'), frame(2, 'HELLO-STDERR\n')]);
  const text = dockerLogToText(buf);
  assert.equal(text, 'HELLO-STDOUT\nHELLO-STDERR\n');
  assert.ok(!text.includes('\x00'), '正文不应含 NUL');
  assert.ok(!text.includes('\x01'), '正文不应含流别字节');
});

test('stdout 与 stderr 分流标记正确', () => {
  const frames = demuxDockerLog(Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n'), frame(1, 'out2\n')]));
  assert.deepEqual(frames.map((f) => f.stream), ['stdout', 'stderr', 'stdout']);
  assert.deepEqual(frames.map((f) => f.data.toString('utf8')), ['out\n', 'err\n', 'out2\n']);
});

test('一帧含多行 —— Docker 按写入分帧，不是按行', () => {
  const chunk = '26 Aug 10:00:00 - [info] Starting flows\n26 Aug 10:00:01 - [info] Started flows\n';
  assert.equal(dockerLogToText(frame(1, chunk)), chunk);
});

test('Tty:true 的原始字节原样返回', () => {
  // 未加帧头时首字节是可见字符，探测应判否并整段按 stdout 收下
  const raw = Buffer.from('26 Aug 10:00:00 - [info] Node-RED version: v5.0.4\n', 'utf8');
  assert.equal(dockerLogToText(raw), raw.toString('utf8'));
  assert.deepEqual(demuxDockerLog(raw).map((f) => f.stream), ['stdout']);
});

test('空缓冲返回空', () => {
  assert.equal(dockerLogToText(Buffer.alloc(0)), '');
  assert.deepEqual(demuxDockerLog(Buffer.alloc(0)), []);
});

test('UTF-8 被切到两帧仍能还原', () => {
  // Docker 按写入分帧，多字节字符可能骑在帧边界上；逐帧解码会在切口留替换字符
  const zh = Buffer.from('一号产线已启动\n', 'utf8');
  const cut = 4; // 落在某个汉字的三字节中间
  const buf = Buffer.concat([frame(1, zh.subarray(0, cut)), frame(1, zh.subarray(cut))]);
  const text = dockerLogToText(buf);
  assert.equal(text, '一号产线已启动\n');
  assert.ok(!text.includes('�'), '不应出现替换字符');
});

test('末帧被 tail 截断时不抛异常，按实有字节还原', () => {
  const full = Buffer.concat([frame(1, 'first\n'), frame(1, 'second-line-truncated\n')]);
  const cut = full.subarray(0, full.length - 8);
  assert.equal(dockerLogToText(cut), 'first\nsecond-line-tr');
});

test('载荷首字节恰为 0x01 的原始文本不会被误判为帧', () => {
  // 帧头判定要求字节 1~3 全零；单看首字节会误判
  const raw = Buffer.from([0x01, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48]);
  assert.deepEqual(demuxDockerLog(raw).map((f) => f.data.toString('latin1')), [raw.toString('latin1')]);
});
