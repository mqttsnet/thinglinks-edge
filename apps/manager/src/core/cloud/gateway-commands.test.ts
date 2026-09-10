import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openDb } from '../db.ts';
import { CloudGateway } from './gateway.ts';
import { dataSignOf, parseEnvelopeFull } from './envelope.ts';
import { CommandBridge } from './commands/bridge.ts';

test('raw Cloud Long MID crosses MQTT dispatch, SQLite dedup, lease completion and exact numeric MQTT receipt',async()=>{
  class Client extends EventEmitter {
    sent:string[]=[];
    subscribe() {}
    async publishAsync(_topic:string,payload:string){this.sent.push(payload);}
    async endAsync() {}
  }
  const client=new Client(),cipher={cipherFlag:0 as const,signKey:'mid-integration-fixture'};
  const gateway=new CloudGateway({brokerUrl:'mqtt://fixture',credentials:{clientId:'gateway@1',deviceIdentification:'gateway',username:'fixture',password:'fixture'},
    cipher,connectFn:()=>client as never});
  const connecting=gateway.connect();client.emit('connect');await connecting;
  const db=openDb(':memory:');
  const bridge=new CommandBridge({db,cloud:{status:()=>({deviceIdentification:'gateway'}),onCommand:()=>()=>{},onStateChange:()=>()=>{},
    publishCommandResponse:(mid,body)=>gateway.publishCommandResponse(mid,body)}});
  const pending:Promise<void>[]=[];gateway.onCommand(command=>{pending.push(bridge.receive(command));});
  const mids=['480000000000000001','480000000000000002','9223372036854775807'];
  const deliver=(mid:string)=>client.emit('message',gateway.topics.command,Buffer.from(
    `{"head":{"mid":${mid},"timeStamp":1,"cipherFlag":0},"dataBody":{"deviceIdentification":"device","msgType":"cloudReq","serviceCode":"control","cmd":"set","params":{"value":5}},"dataSign":"${dataSignOf(1,cipher.signKey)}"}`));
  try {
    bridge.registerBindings('a',{consumerId:'consumer',nodeId:'device',serviceCode:'control',commands:[{cmd:'set',param:'value'}]});
    for(const mid of mids)deliver(mid);deliver(mids[0]!);await Promise.all(pending);
    assert.equal(bridge.list().length,3);
    for(const mid of mids) {
      const leased=bridge.next('a',{consumerId:'consumer',nodeId:'device',serviceCode:'control'})!;
      assert.equal(leased.mid,mid);
      await bridge.complete('a',leased.id,{leaseToken:leased.leaseToken,ok:true});
      const response=client.sent.at(-1)!;
      assert.ok(response.includes(`"mid":${mid},`));
      assert.equal(parseEnvelopeFull(response,cipher).head.mid,mid);
    }
    assert.equal(bridge.next('a',{consumerId:'consumer',nodeId:'device',serviceCode:'control'}),null);
  }finally{await bridge.close();await gateway.close();db.close();}
});
