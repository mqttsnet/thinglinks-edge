import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

/** Real Edge gateway and bridge, with a SQLite adapter only for this disposable runtime fixture. */
export async function createCloudBridge() {
  const mqtt = createRequire('/usr/src/node-red/package.json')('mqtt');
  const { CloudGateway } = await import('/data/protocol-core/cloud/gateway.ts');
  const { CommandBridge } = await import('/data/protocol-core/cloud/commands/bridge.ts');
  const { buildEnvelope, parseEnvelopeFull, serializeEnvelope } = await import(
    '/data/protocol-core/cloud/envelope.ts'
  );
  const sqlite = new DatabaseSync(':memory:');
  const db = {
    exec: (sql) => sqlite.exec(sql),
    prepare: (sql) => sqlite.prepare(sql),
    transaction:
      (fn) =>
      (...args) => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const value = fn(...args);
          sqlite.exec('COMMIT');
          return value;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
  };
  const cipher = { cipherFlag: 0, signKey: 'protocol-fixture-sign-key', encryptKey: '', encryptVector: '' };
  const gateway = new CloudGateway({
    brokerUrl: 'mqtt://protocol-mqtt:1883',
    credentials: {
      clientId: 'edge-command-fixture',
      deviceIdentification: 'fixture-gateway',
      username: '',
      password: '',
    },
    cipher,
    qos: 1,
  });
  const cloud = {
    status: () => ({ deviceIdentification: 'fixture-gateway' }),
    onCommand: (fn) => gateway.onCommand(fn),
    onStateChange: (fn) => gateway.onStateChange(fn),
    publishCommandResponse: (mid, body) => gateway.publishCommandResponse(mid, body),
  };
  const bridge = new CommandBridge({ db, cloud });
  bridge.start();
  await gateway.connect();
  const publisher = await mqtt.connectAsync('mqtt://protocol-mqtt:1883', {
    clientId: 'thinglinks-command-simulator',
  });
  const receipts = [];
  publisher.on('message', (topic, payload) => {
    if (topic === gateway.topics.commandResponse)
      receipts.push({
        ...parseEnvelopeFull(payload, cipher),
        wireMidToken: /"mid"\s*:\s*(\d+)/.exec(payload.toString())?.[1],
      });
  });
  await publisher.subscribeAsync(gateway.topics.commandResponse, { qos: 1 });
  return {
    bridge,
    receipts,
    bindings: () => db.prepare('SELECT node_id AS nodeId FROM cloud_command_binding').all(),
    async issue({ mid, deviceId, value, cmd = 'setTemperature' }) {
      const envelope = buildEnvelope(
        {
          deviceIdentification: deviceId,
          productIdentification: 'fixture-product',
          msgType: 'cloudReq',
          serviceCode: 'telemetry',
          cmd,
          params: { value },
          versionNo: '1.0.0',
        },
        cipher,
        { mid },
      );
      await publisher.publishAsync(gateway.topics.command, serializeEnvelope(envelope), { qos: 1 });
      return { published: true, mid };
    },
    async close() {
      await bridge.close();
      await publisher.endAsync();
      await gateway.close();
      sqlite.close();
    },
  };
}
