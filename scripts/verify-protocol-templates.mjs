#!/usr/bin/env node
/* global process, console, fetch, AbortSignal, setTimeout */
/** Run only against state produced by verify-protocol-components --keep. It does not own cleanup. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  renderBuiltinTemplate,
  getBuiltinTemplate,
} from '../apps/manager/src/core/flows/templates/catalog.ts';
import { parameterDefaults } from '../apps/manager/src/core/flows/templates/parameters.ts';
import { appendFlows } from '../apps/manager/src/core/flows/merge.ts';
import { validateRecipeTarget } from './protocol-fixtures/ownership.mjs';

const run = promisify(execFile);
const stateFile = process.argv[2];
assert.ok(stateFile, 'pass the exact verifier state.json path');
const state = JSON.parse(await readFile(stateFile, 'utf8'));
assert.equal(state.verified, true, 'offline component verification must pass first');
assert.equal(resolve(dirname(stateFile)), resolve(state.directory));
assert.match(state.instanceId ?? '', /^[a-f0-9]{64}$/);
assert.match(state.network ?? '', /^[a-f0-9]{64}$/);
const docker = async (args) => (await run('docker', args, { maxBuffer: 1024 * 1024 })).stdout.trim();
const info = JSON.parse(await docker(['inspect', state.instanceId]))[0];
const network = JSON.parse(await docker(['network', 'inspect', state.network]))[0];
state.url = validateRecipeTarget(state, info, network);
const fixtureRun = randomUUID();
const commandTest = process.argv.includes('--commands');

// Only a previous process of this exact fixture in the already-validated task container may be stopped.
await docker([
  'exec',
  state.instanceId,
  'node',
  '-e',
  "const fs=require('node:fs');for(const pid of fs.readdirSync('/proc')){if(!/^\\d+$/.test(pid))continue;try{const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0').filter(Boolean);if(args.length===2&&args[0]==='node'&&args[1]==='/data/protocol-fixtures.cjs')process.kill(Number(pid),'SIGTERM');}catch{}}",
]);
if (commandTest) {
  if (!state.brokerId) {
    const config = join(state.directory, 'mosquitto.conf');
    await writeFile(config, 'listener 1883\nallow_anonymous true\npersistence false\nlog_dest stdout\n');
    const id = await docker([
      'create',
      '--name',
      `${state.label}-mqtt`,
      '--network',
      state.network,
      '--network-alias',
      'protocol-mqtt',
      '--label',
      `com.mqttsnet.thinglinks-edge.protocol-verification=${state.label}`,
      '--read-only',
      '--mount',
      `type=bind,src=${config},dst=/mosquitto/config/mosquitto.conf,readonly`,
      'eclipse-mosquitto:2.1.2-alpine',
    ]);
    state.brokerId = id;
    state.containers.push(id);
    await writeFile(stateFile, JSON.stringify(state, null, 2));
    await docker(['start', id]);
  } else {
    const broker = JSON.parse(await docker(['inspect', state.brokerId]))[0];
    assert.equal(broker.Config.Labels['com.mqttsnet.thinglinks-edge.protocol-verification'], state.label);
    assert.equal(broker.Name, `/${state.label}-mqtt`);
  }
  await docker(['exec', state.instanceId, 'mkdir', '-p', '/data/protocol-core/cloud']);
  await docker([
    'cp',
    resolve('apps/manager/src/core/cloud') + '/.',
    `${state.instanceId}:/data/protocol-core/cloud/`,
  ]);
  await docker([
    'cp',
    resolve('scripts/protocol-fixtures/cloud-bridge.mjs'),
    `${state.instanceId}:/data/cloud-bridge.mjs`,
  ]);
  await docker([
    'exec',
    state.instanceId,
    'node',
    '-e',
    "const fs=require('node:fs');const target='/data/node_modules/mqtt';if(!fs.existsSync(target))fs.symlinkSync('/usr/src/node-red/node_modules/mqtt',target);",
  ]);
}

async function local(path, body) {
  const code = `const r=await fetch('http://127.0.0.1:19101'+${JSON.stringify(path)},${JSON.stringify({
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })});if(!r.ok)throw Error('fixture HTTP '+r.status);console.log(await r.text());`;
  return JSON.parse(await docker(['exec', state.instanceId, 'node', '--input-type=module', '-e', code]));
}
async function waitFor(name, fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {
      /* readiness */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out: ${name}`);
}

await docker([
  'cp',
  resolve('scripts/protocol-fixtures/runtime.cjs'),
  `${state.instanceId}:/data/protocol-fixtures.cjs`,
]);
await docker([
  'exec',
  '-d',
  '-e',
  `PROTOCOL_FIXTURE_RUN=${fixtureRun}`,
  '-e',
  `PROTOCOL_COMMAND_TEST=${commandTest ? '1' : '0'}`,
  state.instanceId,
  'sh',
  '-c',
  'node /data/protocol-fixtures.cjs > /data/protocol-fixtures.log 2>&1',
]);
await waitFor('current-run device fixtures', async () => (await local('/healthz')).run === fixtureRun);
await local('/reset', {});
const seed = [
  { id: 'existing-tab', type: 'tab', label: 'Existing flow remains', disabled: false },
  { id: 'existing-debug', type: 'debug', z: 'existing-tab', name: 'Keep me', active: false, wires: [] },
];
let current = seed;
const scenarios = [
  {
    id: 'builtin:tcp',
    key: 'tcp',
    parameters: { port: 15001 },
    trigger: ['/trigger/tcp', { port: 15001, payload: '{"temperature":25}\n' }],
  },
  {
    id: 'builtin:udp',
    key: 'udp',
    parameters: { port: 15002 },
    trigger: ['/trigger/udp', { port: 15002, payload: '{"temperature":25}' }],
  },
  {
    id: 'builtin:http-poll',
    key: 'http-poll',
    parameters: { url: 'http://127.0.0.1:19101/device-data', interval: 1 },
  },
  { id: 'builtin:http-receive', key: 'http-receive', parameters: { path: '/devices/report' }, http: true },
  {
    id: 'builtin:modbus-tcp',
    key: 'modbus',
    parameters: {
      host: '127.0.0.1',
      port: 15020,
      interval: 1,
      points: [{ source: '0', property: 'temperature', dataType: 'uint16be', scale: 0.1, offset: 0 }],
    },
  },
  {
    id: 'builtin:opcua',
    key: 'opcua',
    parameters: {
      endpoint: 'opc.tcp://127.0.0.1:15040/UA/Fixture',
      interval: 1,
      points: [
        { source: 'ns=1;s=Temperature', property: 'temperature', dataType: 'Double', scale: 1, offset: 0 },
      ],
    },
  },
  { id: 'builtin:s7', key: 's7', parameters: { host: '127.0.0.1', port: 15030, interval: 1 } },
];
const results = [];
for (const scenario of scenarios) {
  const template = getBuiltinTemplate(scenario.id);
  const controlUnavailable = template.parameters.find(field => field.key === 'downlinkEnabled')?.disabledReason;
  const scenarioCommands = commandTest && !controlUnavailable;
  const parameters = {
    ...parameterDefaults(template.parameters),
    nodeId: `fixture-${scenario.key}-${fixtureRun}`,
    serviceCode: 'telemetry',
    ...scenario.parameters,
    ...(scenarioCommands
      ? {
          downlinkEnabled: true,
          commands: [{ cmd: 'setTemperature', param: 'value', property: 'temperature' }],
        }
      : {}),
  };
  if (scenarioCommands && scenario.key.startsWith('http'))
    parameters.commandUrl = 'http://127.0.0.1:19101/device-control';
  const configured = renderBuiltinTemplate(scenario.id, parameters);
  current = appendFlows(current, configured.flows);
  const snapshot = await (
    await fetch(`${state.url}/flows`, { headers: { 'Node-RED-API-Version': 'v2' } })
  ).json();
  const deployedAt = Date.now();
  const response = await fetch(`${state.url}/flows`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Node-RED-API-Version': 'v2',
      'Node-RED-Deployment-Type': 'flows',
    },
    body: JSON.stringify({ rev: snapshot.rev, flows: current }),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `${scenario.key} deployment HTTP ${response.status}`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (scenario.trigger) await local(...scenario.trigger);
  if (scenario.http) {
    const pushed = await fetch(`${state.url}/api/devices/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"temperature":25}',
    });
    assert.equal(pushed.status, 202);
  }
  const report = await waitFor(`${scenario.key} acquisition uplink`, async () =>
    (await local('/reports')).find(
      (r) =>
        r.fixtureRun === fixtureRun &&
        r.receivedAt >= deployedAt &&
        r.nodeId === parameters.nodeId &&
        r.data.temperature === 25,
    ),
  );
  assert.equal(report.serviceId, 'telemetry');
  const readback = await (
    await fetch(`${state.url}/flows`, { headers: { 'Node-RED-API-Version': 'v2' } })
  ).json();
  assert.deepEqual(
    readback.flows.find((n) => n.id === 'existing-debug'),
    seed[1],
  );
  results.push({
    protocol: scenario.key,
    nodeId: parameters.nodeId,
    temperature: report.data.temperature,
    preservedExisting: true,
    controlStatus: commandTest ? (controlUnavailable ? 'unavailable' : 'pending') : 'not-requested',
    ...(commandTest && controlUnavailable ? { controlUnavailableReason: controlUnavailable } : {}),
  });
  console.log(`RECIPE_VERIFIED ${scenario.key}`);
  if (commandTest && controlUnavailable) console.log(`CONTROL_UNAVAILABLE ${scenario.key}: ${controlUnavailable}`);
  if (scenarioCommands) {
    await waitFor(`${scenario.key} command binding`, async () =>
      (await local('/bindings')).some((b) => b.nodeId === parameters.nodeId),
    );
    const deviceKey = scenario.key.startsWith('http') ? 'http' : scenario.key;
    const before = (await local('/state')).writes[deviceKey];
    const mid = (((BigInt(Date.now()) - 1672444800000n) << 22n) + BigInt(results.length)).toString();
    await local('/issue', { mid, deviceId: parameters.nodeId, value: 30 });
    const receipt = await waitFor(`${scenario.key} command execution receipt`, async () =>
      (await local('/receipts')).find(
        (r) => r.head.mid === mid && r.body.deviceIdentification === parameters.nodeId,
      ),
    );
    assert.equal(receipt.body.msgType, 'deviceRsp');
    assert.equal(receipt.body.errCode, 0, JSON.stringify(receipt.body));
    assert.equal(receipt.wireMidToken, mid, 'response head.mid must be the exact unquoted JSON integer');
    const expected = scenario.key === 'modbus' ? 300 : 30;
    assert.equal((await local('/state')).deviceState[deviceKey], expected);
    assert.equal((await local('/state')).writes[deviceKey], before + 1);
    await local('/issue', { mid, deviceId: parameters.nodeId, value: 30 });
    await waitFor(
      'duplicate command reply',
      async () => (await local('/receipts')).filter((r) => r.head.mid === mid).length >= 2,
    );
    assert.equal(
      (await local('/state')).writes[deviceKey],
      before + 1,
      'duplicate MQTT command executed again',
    );
    const invalidMid = (BigInt(mid) + 1n).toString();
    await local('/issue', { mid: invalidMid, deviceId: parameters.nodeId, value: 'invalid-numeric-value' });
    const refused = await waitFor(`${scenario.key} invalid parameter receipt`, async () =>
      (await local('/receipts')).find((r) => r.head.mid === invalidMid),
    );
    assert.equal(refused.body.errCode, 1);
    assert.equal(refused.wireMidToken, invalidMid);
    assert.equal((await local('/state')).writes[deviceKey], before + 1, 'invalid command changed the device');
    results.at(-1).command = {
      mid,
      errCode: receipt.body.errCode,
      deviceValue: expected,
      duplicateDidNotExecute: true,
      invalidParameterDidNotExecute: true,
    };
    results.at(-1).controlStatus = 'passed';
    console.log(`COMMAND_VERIFIED ${scenario.key}`);
  }
}
if (commandTest) {
  for (const protocol of ['modbus', 'opcua']) {
    const result = results.find((item) => item.protocol === protocol);
    if (result?.controlStatus !== 'passed') continue;
    const before = (await local('/state')).writes[protocol];
    await local('/availability', { protocol, available: false });
    const mid = (((BigInt(Date.now()) - 1672444800000n) << 22n) + 99n).toString();
    await local('/issue', { mid, deviceId: result.nodeId, value: 35 });
    const reply = await waitFor(
      `${protocol} offline receipt`,
      async () => (await local('/receipts')).find((r) => r.head.mid === mid),
      45000,
    );
    assert.equal(reply.body.errCode, 1);
    await local('/availability', { protocol, available: true });
    await new Promise((resolve) => setTimeout(resolve, 3500));
    await local('/issue', { mid, deviceId: result.nodeId, value: 35 });
    await waitFor(
      'offline duplicate receipt',
      async () => (await local('/receipts')).filter((r) => r.head.mid === mid).length >= 2,
    );
    assert.equal(
      (await local('/state')).writes[protocol],
      before,
      'expired/offline command executed on reconnection',
    );
    result.command.offlineDidNotReplay = true;
    console.log(`OFFLINE_COMMAND_VERIFIED ${protocol}`);
  }
}
const artifact = join(state.directory, commandTest ? 'command-results.json' : 'recipe-results.json');
await writeFile(
  artifact,
  JSON.stringify(
    {
      imageId: state.imageId,
      scope: commandTest
        ? 'Available controls only: actual MQTT broker → actual CloudGateway/CommandBridge with fixture SQLite adapter → Node-RED protocol writes → simulated device confirmation → standard MQTT receipt. Unavailable controls are reported separately; OPC UA acquisition is still verified. No deployed ThingLinks or hardware.'
        : 'Simulated devices → actual Node-RED drivers → actual tl-uplink → fixture ingest. No deployed ThingLinks or real hardware.',
      ...(commandTest ? { controlCoverage: {
        requested: results.length,
        passed: results.filter(result => result.controlStatus === 'passed').length,
        unavailable: results.filter(result => result.controlStatus === 'unavailable').map(result => ({protocol:result.protocol,reason:result.controlUnavailableReason})),
        allRequestedControlsAvailable: !results.some(result => result.controlStatus === 'unavailable'),
      } } : {}),
      results,
    },
    null,
    2,
  ),
);
if (commandTest) console.log(`CONTROL_COVERAGE passed=${results.filter(result => result.controlStatus === 'passed').length} unavailable=${results.filter(result => result.controlStatus === 'unavailable').length} requested=${results.length}`);
console.log(`PROTOCOL_RECIPES_VERIFIED ${artifact}`);
