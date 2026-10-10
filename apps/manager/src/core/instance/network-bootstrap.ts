/** Public, immutable startup gate. Never load executable bootstrap code from writable /data. */
export const NETWORK_BOOTSTRAP_SOURCE = String.raw`
'use strict';
const http = require('node:http');
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const networkId = process.env.TLE_NETWORK_GUARD_ID || '';
const gateway = process.env.TLE_NETWORK_GUARD_GATEWAY || '';
const port = Number(process.env.TLE_NETWORK_GUARD_PORT);
const octets = gateway.split('.');
let child, activeRequest, stopping = false;
function stop(signal) {
  stopping = true;
  if (child) child.kill(signal);
  else { if (activeRequest) activeRequest.destroy(); process.exit(signal === 'SIGINT' ? 130 : 143); }
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
function ready(timeoutMs) {
  return new Promise(resolve => {
    let done = false, request;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = value => {
      if (!done) { done = true; clearTimeout(timer); if (request) request.destroy(); resolve(value); }
    };
    request = http.get({ hostname: gateway, port, path: '/ready?network=' + networkId, agent: false }, response => {
      if (response.statusCode !== 200) { finish(false); return; }
      let body = '', size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024) { request.destroy(); finish(false); } else body += chunk;
      });
      response.once('end', () => {
        try { const value = JSON.parse(body); finish(value.ready === true && value.networkId === networkId); }
        catch { finish(false); }
      });
      response.once('error', () => finish(false));
    });
    activeRequest = request;
    request.once('error', () => finish(false));
  });
}
async function main() {
  if (!/^[a-f0-9]{64}$/.test(networkId) || octets.length !== 4
    || !octets.every(value => /^(0|[1-9][0-9]{0,2})$/.test(value) && Number(value) <= 255)
    || !Number.isInteger(port) || port < 1024 || port > 65535) { process.exit(78); return; }
  console.error('[network-guard] waiting for verified network isolation');
  const deadline = Date.now() + 180000;
  while (!stopping && Date.now() < deadline) {
    if (await ready(Math.min(2000, Math.max(1, deadline - Date.now())))) {
      if (stopping) return;
      child = spawn('/usr/local/bin/node', [
        '/usr/src/node-red/node_modules/node-red/red.js', '--userDir', '/data', '--settings', '/data/settings.js'
      ], { cwd: '/usr/src/node-red', env: process.env, stdio: 'inherit' });
      child.once('error', () => process.exit(78));
      child.once('close', (code, signal) => process.exit(Number.isInteger(code) ? code : 128 + (constants.signals[signal] || 1)));
      return;
    }
    const delay = Math.min(1000, Math.max(0, deadline - Date.now()));
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  if (!stopping) { console.error('[network-guard] network isolation unavailable; Node-RED was not started'); process.exit(78); }
}
main().catch(() => { console.error('[network-guard] startup failed'); process.exit(78); });
`.trim();

export function networkBootstrapEntrypoint(): string[] {
  return ['/usr/local/bin/node', '-e', NETWORK_BOOTSTRAP_SOURCE];
}

/** These overrides also neutralize unsafe startup hooks inherited from an image. */
export const INSTANCE_STARTUP_ENV = [
  'NODE_OPTIONS=', 'LD_PRELOAD=', 'LD_LIBRARY_PATH=', 'LD_AUDIT=', 'ENV=', 'BASH_ENV=',
] as const;

export const INSTANCE_IPV6_SYSCTLS = {
  'net.ipv6.conf.all.disable_ipv6': '1',
  'net.ipv6.conf.default.disable_ipv6': '1',
} as const;
