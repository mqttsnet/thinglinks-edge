import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demuxDockerLog, dockerLogToText, DockerLogStream, splitTimestamp } from './log-stream.ts';

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

// ── 流式解帧 ────────────────────────────────────────────────
// 一次性解帧只需处理完整缓冲；流式要跨块保持状态，帧头、载荷、多字节字符
// 都可能被切在块边界上。下面每条用例都对应一种真实的切法。

test('流式：一块含多帧多行', () => {
  const s = new DockerLogStream();
  const buf = Buffer.concat([frame(1, 'a\nb\n'), frame(2, 'c\n')]);
  assert.deepEqual(s.push(buf), [
    { stream: 'stdout', text: 'a' },
    { stream: 'stdout', text: 'b' },
    { stream: 'stderr', text: 'c' },
  ]);
});

test('流式：帧头被切成两块', () => {
  const s = new DockerLogStream();
  const f = frame(1, 'hello\n');
  assert.deepEqual(s.push(f.subarray(0, 5)), [], '帧头没齐时不能吐任何东西');
  assert.deepEqual(s.push(f.subarray(5)), [{ stream: 'stdout', text: 'hello' }]);
});

test('流式：载荷被切成两块', () => {
  const s = new DockerLogStream();
  const f = frame(1, 'hello world\n');
  assert.deepEqual(s.push(f.subarray(0, 12)), [], '载荷没齐时要继续等');
  assert.deepEqual(s.push(f.subarray(12)), [{ stream: 'stdout', text: 'hello world' }]);
});

test('流式：多字节字符骑在块边界上', () => {
  const s = new DockerLogStream();
  const zh = Buffer.from('一号产线已启动\n', 'utf8');
  const f = Buffer.concat([frame(1, zh)]);
  const cut = 8 + 4; // 帧头之后第 4 字节，落在某个汉字中间
  const out = [...s.push(f.subarray(0, cut)), ...s.push(f.subarray(cut))];
  assert.deepEqual(out, [{ stream: 'stdout', text: '一号产线已启动' }]);
});

test('流式：一帧只含半行，下一帧补全', () => {
  const s = new DockerLogStream();
  assert.deepEqual(s.push(frame(1, '26 Aug 10:00:00 - [info] Start')), [], '半行不吐');
  assert.deepEqual(s.push(frame(1, 'ed flows\n')), [
    { stream: 'stdout', text: '26 Aug 10:00:00 - [info] Started flows' },
  ]);
});

test('流式：stdout 与 stderr 各自拼行，交错也不串', () => {
  const s = new DockerLogStream();
  s.push(frame(1, 'out-part'));
  s.push(frame(2, 'err-part'));
  assert.deepEqual(s.push(Buffer.concat([frame(1, '-1\n'), frame(2, '-2\n')])), [
    { stream: 'stdout', text: 'out-part-1' },
    { stream: 'stderr', text: 'err-part-2' },
  ]);
});

test('流式：flush 吐出末尾没有换行的残行', () => {
  const s = new DockerLogStream();
  assert.deepEqual(s.push(frame(1, 'no trailing newline')), []);
  assert.deepEqual(s.flush(), [{ stream: 'stdout', text: 'no trailing newline' }]);
  assert.deepEqual(s.flush(), [], '再 flush 不应重复吐');
});

test('流式：Tty:true 的无帧头原始流也能按行切', () => {
  const s = new DockerLogStream();
  assert.deepEqual(s.push(Buffer.from('26 Aug - line1\n26 Aug - line2\n', 'utf8')), [
    { stream: 'stdout', text: '26 Aug - line1' },
    { stream: 'stdout', text: '26 Aug - line2' },
  ]);
});

test('流式：首块不足 8 字节时不误判为原始流', () => {
  const s = new DockerLogStream();
  const f = frame(1, 'x\n');
  assert.deepEqual(s.push(f.subarray(0, 3)), [], '首字节 0x01，应继续等而不是当原始流吐出去');
  assert.deepEqual(s.push(f.subarray(3)), [{ stream: 'stdout', text: 'x' }]);
});

// ── 时间戳前缀 ──────────────────────────────────────────────

test('拆出 RFC3339Nano 前缀并把小数补齐到 9 位', () => {
  // Go 的 RFC3339Nano 裁掉末尾的零，宽度不固定，补齐后才能按字符串比大小
  assert.deepEqual(splitTimestamp('2026-08-26T15:10:38.12345Z 26 Aug - [info] hi'),
                   { ts: '2026-08-26T15:10:38.123450000Z', text: '26 Aug - [info] hi' });
  assert.deepEqual(splitTimestamp('2026-08-26T15:10:38Z x'),
                   { ts: '2026-08-26T15:10:38.000000000Z', text: 'x' });
});

test('补齐后时间戳可直接按字符串比较先后', () => {
  const a = splitTimestamp('2026-08-26T15:10:38.9Z a').ts;
  const b = splitTimestamp('2026-08-26T15:10:38.10Z b').ts;
  assert.ok(a > b, '0.9 秒应晚于 0.10 秒 —— 不补齐的话字符串比较会反过来');
});

test('没有时间戳前缀时原样返回', () => {
  assert.deepEqual(splitTimestamp('26 Aug - [info] no prefix'),
                   { ts: '', text: '26 Aug - [info] no prefix' });
  assert.deepEqual(splitTimestamp('single-token'), { ts: '', text: 'single-token' });
});
