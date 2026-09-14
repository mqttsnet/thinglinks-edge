import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { presenceHttpTransport } from './presence-http-transport.ts';
const nodes=()=>presenceHttpTransport();
function run(id:string,msg:Record<string,unknown>){return new Script(`(function(msg){${nodes().find(n=>n.id===id)!.func}})(msg)`).runInNewContext({msg,env:{get:(key:string)=>key==='TLE_MANAGER_URL'?'http://manager:9100/':'manager-secret'}});}
test('HTTP push posts the versioned envelope to the Manager and preserves only in-flight response handles',()=>{
 const res={marker:1};const output=run('presence-uplink-request',{req:{headers:{authorization:'device-secret'}},res,nodeId:'device',serviceId:'telemetry',payload:{__tlePresence:{kind:'sample'},values:{t:1}},headers:{cookie:'device-cookie'}})[0];
 assert.equal(output.url,'http://manager:9100/api/edge/uplink');assert.equal(output.res,res);
 assert.equal(output.headers.authorization,'Bearer manager-secret');assert.equal(JSON.stringify(output.payload).includes('secret'),false);
 assert.deepEqual(JSON.parse(JSON.stringify(output.payload)),{nodeId:'device',serviceId:'telemetry',data:{__tlePresence:{kind:'sample'},values:{t:1}}});
});
test('HTTP push only acknowledges an actual 202 with positive acceptance and never exposes backend headers or errors',()=>{
 for(const [statusCode,body,expected] of [[202,{accepted:1},202],[202,{accepted:0},503],[200,{accepted:1},503],[503,{error:'sensitive backend text'},503],[409,{accepted:1},503]]){
  const output=run('presence-uplink-result',{res:{},req:{},statusCode,payload:body,headers:{authorization:'manager-secret','set-cookie':'backend-cookie'}});
  assert.equal(output.statusCode,expected);assert.equal(JSON.stringify(output).includes('manager-secret'),false);assert.equal(JSON.stringify(output).includes('backend-cookie'),false);assert.equal(JSON.stringify(output).includes('sensitive'),false);
 }
 assert.equal(run('presence-uplink-result',{res:{headersSent:true},statusCode:202,payload:{accepted:1}}),null);
 assert.equal(run('presence-uplink-result',{res:{_res:{headersSent:true}},statusCode:202,payload:{accepted:1}}),null);
 assert.equal(run('presence-uplink-result',{statusCode:202,payload:{accepted:1}}),null,'status envelopes have no HTTP peer');
});
