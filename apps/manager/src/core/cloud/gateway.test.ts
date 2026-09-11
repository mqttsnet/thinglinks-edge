import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CloudGateway, type DownlinkCommand } from './gateway.ts';
import { buildEnvelope, parseEnvelopeFull, serializeEnvelope, dataSignOf } from './envelope.ts';
import type { ProtocolMid } from './mid.ts';
class Client extends EventEmitter {
    sent: {
        topic: string;
        payload: string;
    }[] = [];
    subscribe() { }
    async publishAsync(topic: string, payload: string) { this.sent.push({ topic, payload }); }
    async endAsync() { }
}
const cipher = { cipherFlag: 0 as const, signKey: 'test-sign-key' };
async function fixture() {
    const client = new Client();
    const gateway = new CloudGateway({ brokerUrl: 'mqtt://test', credentials: { clientId: 'gateway@1', deviceIdentification: 'gateway', username: 'u', password: 'p' }, cipher, connectFn: () => client as never, requestTimeoutMs: 100 });
    const connected = gateway.connect();
    client.emit('connect');
    await connected;
    return { client, gateway, deliver: (topic: string, mid: ProtocolMid, body: unknown) => client.emit('message', topic, Buffer.from(serializeEnvelope(buildEnvelope(body, cipher, { mid })))) };
}
test('gateway dispatches only command topics with exact safe mid and gateway identity', async () => {
    const f = await fixture();
    const commands: DownlinkCommand[] = [];
    f.gateway.onCommand(c => commands.push(c));
    try {
        f.deliver(f.gateway.topics.topoAddResponse, 42, { statusCode: 0 });
        f.deliver('/v1/devices/other/command', 43, {});
        f.deliver(f.gateway.topics.command, 44, { cmd: 'set' });
        assert.equal(commands.length, 1);
        assert.equal(commands[0]?.mid, 44);
        assert.equal(commands[0]?.gatewayId, 'gateway');
        assert.throws(()=>f.deliver(f.gateway.topics.command, Number.MAX_SAFE_INTEGER + 1, {}),/mid/);
        assert.equal(commands.length, 1);
    }
    finally {
        await f.gateway.close();
    }
});

test('cloud Snowflake commands dispatch distinct exact mids and MQTT replies preserve numeric wire tokens',async()=>{
  const f=await fixture();const seen:DownlinkCommand[]=[];f.gateway.onCommand(command=>seen.push(command));
  try {
    for(const mid of ['480000000000000001','480000000000000002','9223372036854775807']) {
      const raw=`{"head":{"cipherFlag":0,"mid":${mid},"timeStamp":1},"dataBody":{"cmd":"set"},"dataSign":"${dataSignOf(1,cipher.signKey)}"}`;
      f.client.emit('message',f.gateway.topics.command,Buffer.from(raw));
      assert.equal(seen.at(-1)?.mid,mid);
      await f.gateway.publishCommandResponse(seen.at(-1)!.mid,{errCode:0});
      const reply=f.client.sent.at(-1)!.payload;
      assert.ok(reply.includes(`"mid":${mid},`));
      assert.equal(parseEnvelopeFull(reply,cipher).head.mid,mid);
    }
    assert.equal(seen.length,3);
  }finally{await f.gateway.close();}
});
test('request waiter matches topic and mid, while commandResponse reuses the cloud mid', async () => {
    const f = await fixture();
    try {
        const result = f.gateway.fetchModel({ productIdentification: 'p', versionNo: 'v' });
        const request = f.client.sent.at(-1)!;
        const mid = parseEnvelopeFull(request.payload, cipher).head.mid;
        f.deliver(f.gateway.topics.topoAddResponse, mid, { statusCode: 0, model: { productName: 'WRONG' } });
        f.deliver(f.gateway.topics.modelQueryResponse, mid, { statusCode: 0, statusDesc: 'success', versionNo: 'v', model: { productIdentification: 'p', services: [] } });
        assert.equal((await result).model.productIdentification, 'p');
        await f.gateway.publishCommandResponse(123, { deviceIdentification: 'device', msgType: 'deviceRsp', serviceCode: 'control', cmd: 'set', errCode: 0, params: { value: 1 }, errMsg: '' });
        const reply = f.client.sent.at(-1)!;
        assert.equal(reply.topic, f.gateway.topics.commandResponse);
        assert.equal(parseEnvelopeFull(reply.payload, cipher).head.mid, 123);
    }
    finally {
        await f.gateway.close();
    }
});
test('actuation does not accept legacy unsigned envelopes', async () => {
    const f = await fixture();
    let executed = 0;
    f.gateway.onCommand(() => executed++);
    try {
        const envelope = buildEnvelope({ cmd: 'set' }, cipher, { mid: 70 });
        envelope.dataSign = '';
        f.client.emit('message', f.gateway.topics.command, Buffer.from(JSON.stringify(envelope)));
        assert.equal(executed, 0);
    }
    finally {
        await f.gateway.close();
    }
});
test('stalled MQTT acknowledgements cannot hang command receipts or model requests forever', async () => {
    const f = await fixture();
    f.client.publishAsync = async () => new Promise<void>(() => { });
    try {
        await assert.rejects(() => f.gateway.publishCommandResponse(80, {}), /超时/);
        await assert.rejects(() => f.gateway.fetchModel({ productIdentification: 'p', versionNo: 'v' }), /超时/);
    }
    finally {
        await f.gateway.close();
    }
});

test('topology query subscribes to its response and sends an explicit bounded deviceIds request', async () => {
  const f = await fixture();
  try {
    const queried = f.gateway.querySubDevices(['child']);
    const request = f.client.sent.at(-1)!;
    assert.equal(request.topic, '/v1/devices/gateway/topo/query');
    assert.deepEqual(parseEnvelopeFull(request.payload, cipher).body, { deviceIds: ['child'] });
    const response = { statusCode: 0, data: [{ deviceId: 'child', statusCode: 0, deviceInfo: { nodeType: 2, gatewayId: 'gateway' } }] };
    f.deliver(f.gateway.topics.topoQueryResponse, parseEnvelopeFull(request.payload, cipher).head.mid, response);
    assert.deepEqual(await queried, response);
    assert.throws(() => f.gateway.querySubDevices([]));
    assert.throws(() => f.gateway.querySubDevices(['child', 'child']));
    assert.throws(() => f.gateway.querySubDevices(Array.from({ length: 101 }, (_, i) => `child-${i}`)));
  } finally { await f.gateway.close(); }
});

test('aborted topology requests stop waiting without applying a late response', async () => {
  const f = await fixture(); const abort = new AbortController();
  try {
    const pending = f.gateway.querySubDevices(['child'], abort.signal);
    abort.abort(); await assert.rejects(pending, /取消/);
    const next = f.gateway.querySubDevices(['child']); const request = f.client.sent.at(-1)!;
    f.deliver(f.gateway.topics.topoQueryResponse, parseEnvelopeFull(request.payload, cipher).head.mid, { statusCode: 0, data: [] });
    await next;
  } finally { await f.gateway.close(); }
});

test('ownership and status response topics reject empty signatures without changing legacy model response rules', async () => {
  for (const query of [true, false]) {
    const f = await fixture();
    try {
      const pending = query ? f.gateway.querySubDevices(['child']) : f.gateway.updateSubDeviceStatus([{ deviceId: 'child', status: 'ONLINE' }]);
      const request = f.client.sent.at(-1)!; const mid = parseEnvelopeFull(request.payload, cipher).head.mid;
      const topic = query ? f.gateway.topics.topoQueryResponse : f.gateway.topics.topoUpdateResponse;
      const unsigned = buildEnvelope({ statusCode: 0, data: [{ deviceId: 'child', statusCode: 0 }] }, cipher, { mid }); unsigned.dataSign = '';
      f.client.emit('message', topic, Buffer.from(JSON.stringify(unsigned)));
      let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(r => setImmediate(r)); assert.equal(settled, false);
      f.deliver(topic, mid, { statusCode: 0, data: [] }); await pending;
    } finally { await f.gateway.close(); }
  }
});
