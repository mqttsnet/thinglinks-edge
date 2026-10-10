import { TemplateError } from '../types.ts';

/** Node-RED's HTTP node consumes msg.requestTimeout. Keep request ownership in flow context. */
export function httpRequestStartScript(requestTimeout = 10_000): string {
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 100 || requestTimeout > 60_000) {
    throw new TemplateError('HTTP 读取超时必须是 100–60000 毫秒的整数');
  }
  const pendingLifetime = requestTimeout + 5_000;
  return `const key = 'tle-http-pending-' + node.id;
const now = Date.now();
const pending = flow.get(key);
if (pending && pending.expiresAt > now) return null;
const sequence = (context.get('http-request-sequence') || 0) + 1;
context.set('http-request-sequence', sequence);
const token = String(now) + ':' + String(sequence);
flow.set(key, {token, expiresAt: now + ${pendingLifetime}});
msg._tleHttpPoll = {key, token};
msg.requestTimeout = ${requestTimeout};
return msg;`;
}

/** Only the current request may release the gate. Late responses never become fresh telemetry. */
export function httpResponseScript(observePresence = false): string {
  return `const request = msg._tleHttpPoll;
if (!request || typeof request.key !== 'string') return null;
const pending = flow.get(request.key);
if (!pending || pending.token !== request.token) return null;
flow.set(request.key, undefined);
delete msg._tleHttpPoll;
if (pending.expiresAt <= Date.now()) return null;
${observePresence ? "node.send([null,typeof msg.statusCode==='string'?{_tlePresenceSource:true,error:{code:msg.statusCode}}:{_tlePresenceSource:true,statusCode:msg.statusCode}]);" : ''}
if (!Number.isInteger(msg.statusCode) || msg.statusCode < 200 || msg.statusCode >= 300) {
  node.error('设备接口未返回成功状态', msg);
  return null;
}
return msg;`;
}

/** Catch also carries parse/uplink failures: retain those messages for the error log. */
export function httpRequestErrorScript(observePresence = false): string {
  return `const request = msg._tleHttpPoll;
if (request && typeof request.key === 'string') {
  const pending = flow.get(request.key);
  if (pending && pending.token === request.token) {
    flow.set(request.key, undefined);
    ${observePresence ? "if(pending.expiresAt>Date.now())node.send([null,{_tlePresenceSource:true,error:msg.error}]);" : ''}
  }
}
delete msg._tleHttpPoll;
return msg;`;
}
