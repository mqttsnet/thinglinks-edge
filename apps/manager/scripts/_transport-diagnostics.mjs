// Never serialize error messages, requests, headers, bodies, or arbitrary cause
// objects: transport errors may contain credentials. Keep only diagnostic codes.
import { get } from 'node:http';
const token = (value) => typeof value === 'string' && /^[A-Z][A-Za-z0-9_]{0,63}$/.test(value)
  ? value : undefined;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function transportDiagnostics(error, elapsedMs) {
  const result = { elapsedMs: count(elapsedMs), errors: [] };
  const seen = new Set();
  for (let current = error; current && !seen.has(current) && seen.size < 4; current = current.cause) {
    seen.add(current);
    result.errors.push({ name: token(current.name), code: token(current.code) });
    if (Array.isArray(current.errors)) {
      result.connectionCodes = current.errors.slice(0, 4).map((entry) => token(entry?.code));
    }
    if (current.socket) {
      result.socket = {
        bytesRead: count(current.socket.bytesRead), bytesWritten: count(current.socket.bytesWritten),
      };
    }
  }
  return result;
}

/** Independent socket: a Connection: close header alone can reuse fetch's pool. */
export function probeFreshHttpStatus(url, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    try {
      const request = get(url, { agent: false, signal: AbortSignal.timeout(timeoutMs) }, (response) => {
        response.on('error', () => resolve(0));
        response.on('end', () => resolve(response.statusCode ?? 0));
        response.resume();
      });
      request.on('error', () => resolve(0));
    } catch { resolve(0); }
  });
}
