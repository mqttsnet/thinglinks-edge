/** Node-RED's HTTP node consumes msg.requestTimeout. Keep request ownership in flow context. */
const REQUEST_TIMEOUT_MS = 10_000;
const PENDING_LIFETIME_MS = REQUEST_TIMEOUT_MS + 5_000;

export function httpRequestStartScript(): string {
  return `const key = 'tle-http-pending-' + node.id;
const now = Date.now();
const pending = flow.get(key);
if (pending && pending.expiresAt > now) return null;
const sequence = (context.get('http-request-sequence') || 0) + 1;
context.set('http-request-sequence', sequence);
const token = String(now) + ':' + String(sequence);
flow.set(key, {token, expiresAt: now + ${PENDING_LIFETIME_MS}});
msg._tleHttpPoll = {key, token};
msg.requestTimeout = ${REQUEST_TIMEOUT_MS};
return msg;`;
}

/** Only the current request may release the gate. Late responses never become fresh telemetry. */
export function httpResponseScript(): string {
  return `const request = msg._tleHttpPoll;
if (!request || typeof request.key !== 'string') return null;
const pending = flow.get(request.key);
if (!pending || pending.token !== request.token) return null;
flow.set(request.key, undefined);
delete msg._tleHttpPoll;
if (pending.expiresAt <= Date.now()) return null;
if (!Number.isInteger(msg.statusCode) || msg.statusCode < 200 || msg.statusCode >= 300) {
  node.error('设备接口未返回成功状态', msg);
  return null;
}
return msg;`;
}

/** Catch also carries parse/uplink failures: retain those messages for the error log. */
export function httpRequestErrorScript(): string {
  return `const request = msg._tleHttpPoll;
if (request && typeof request.key === 'string') {
  const pending = flow.get(request.key);
  if (pending && pending.token === request.token) flow.set(request.key, undefined);
}
delete msg._tleHttpPoll;
return msg;`;
}
