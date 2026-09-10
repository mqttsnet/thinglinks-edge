/** Bounded per-connection framing; the TCP transport's packet boundaries are not device frames. */
export function framingScript(mode: 'newline' | 'fixed', frameLength: number): string {
  return `const mode = ${JSON.stringify(mode)}, length = ${JSON.stringify(frameLength)};
const state = context.get('frames') || {};
const now = Date.now();
for (const key of Object.keys(state)) if (now - state[key].time > 60000) delete state[key];
const key = '$' + (msg._tleCommand && msg._tleCommand.id || msg._session && msg._session.id || 'client');
try {
  if (!Buffer.isBuffer(msg.payload)) throw new Error('TCP 输入必须是二进制数据');
  if (!state[key] && Object.keys(state).length >= 128) throw new Error('TCP 活跃连接分帧上限为 128');
  const previous = state[key] ? state[key].buffer : Buffer.alloc(0);
  if (previous.length + msg.payload.length > 1048576) throw new Error('TCP 单次数据超过 1 MiB');
  let buffer = Buffer.concat([previous, msg.payload]);
  const frames = [];
  while (buffer.length) {
    const size = mode === 'fixed' ? (buffer.length >= length ? length : -1) : buffer.indexOf(10);
    if (size < 0) break;
    if (size > 65536) throw new Error('TCP 单帧超过 64 KiB');
    let frame = buffer.subarray(0, size);
    if (mode === 'newline' && frame[frame.length-1] === 13) frame = frame.subarray(0,frame.length-1);
    if (frame.length) frames.push(Buffer.from(frame));
    buffer = buffer.subarray(size + (mode === 'newline' ? 1 : 0));
    if (frames.length > 2048) throw new Error('TCP 单批帧数量过多');
  }
  if (buffer.length > 65536) throw new Error('TCP 不完整帧超过 64 KiB');
  if (buffer.length) state[key] = {buffer:Buffer.from(buffer),time:now}; else delete state[key];
  context.set('frames',state);
  for (const frame of frames) node.send({...msg,payload:frame});
} catch(error) {
  delete state[key]; context.set('frames',state);
  node.error('TCP 分帧失败：' + error.message, msg);
}
return null;`;
}
