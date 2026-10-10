import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCreateOptions,assertSafeCreateOptions} from './container-spec.ts';
const options=()=>buildCreateOptions({id:'native-test',imageTag:'5.0.4-24-minimal',memoryMb:512,cpus:0.5,ports:[],adminRoot:'/red/native-test/'},{network:'tle-native-test',imageRepo:'nodered/node-red',instanceDataRoot:'/srv/edge/instances',timezone:'UTC'});
const guard=(value:Record<string,unknown>)=>assertSafeCreateOptions(value,{instanceDataRoot:'/srv/edge/instances',expectedNetwork:'tle-native-test'});
test('普通镜像不自动启用 OPC UA 原生覆盖，受管镜像只接受固定只读构件路径',()=>{
 const base=options();assert.equal((base['Env'] as string[]).some(v=>v.startsWith('OPCUA_OPEN62541_ADDON=')),false);guard(base);
 const key='OPCUA_OPEN62541_ADDON=';const fixed='/opt/thinglinks/opcua-native/opcua_open62541.node';
 guard({...base,Env:[...base['Env'] as string[],key+fixed]});
 for(const values of [['OPCUA_OPEN62541_ADDON'],[key+'/data/addon.node'],[key+'/tmp/addon.node'],[key+fixed+'/../evil.node'],[key],[key+fixed,key+fixed]]){
  assert.throws(()=>guard({...base,Env:[...base['Env'] as string[],...values]}),/原生构件/);
 }
});
