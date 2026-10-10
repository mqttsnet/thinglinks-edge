import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { observationScript, type ObservedProtocol } from './presence-observation.ts';
const observe = (protocol: ObservedProtocol, msg: unknown) => JSON.parse(JSON.stringify(new Script(`(function(msg){${observationScript(protocol)}})(msg)`).runInNewContext({ msg })));

test('S7 and Modbus distinguish native disconnection states from arbitrary red or Modbus exception status', () => {
  assert.equal(observe('s7', {status:{text:'offline'}}).unavailable, 'candidate');
  assert.equal(observe('s7', {status:{text:'verbinde'}}).unavailable, 'candidate');
  assert.equal(observe('s7', {status:{text:'online'}}).ready, true);
  for (const text of ['closed','broken','retrying after 5000 msec. (attempt 2)']) assert.equal(observe('modbus', {status:{text}}).unavailable, 'candidate');
  for (const text of ['error Modbus exception 2','failure','error','reading done']) assert.deepEqual(observe('modbus', {status:{text,fill:'red'}}), {});
});

test('HTTP successful transport clears timeout candidates without claiming successful data or ONLINE', () => {
  assert.deepEqual(observe('http-poll', {statusCode:401}), {reachable:true});
  assert.deepEqual(observe('http-poll', {statusCode:500}), {reachable:true});
  assert.deepEqual(observe('http-poll', {error:{message:'request ETIMEDOUT'}}), {unavailable:'candidate',consecutive:true});
  assert.deepEqual(observe('http-poll', {error:{message:'connect ECONNREFUSED 192.0.2.2'}}), {unavailable:'immediate'});
  assert.deepEqual(observe('http-poll', {error:{message:'invalid JSON'}}), {});
});

test('TCP server requires a native total count of zero; closing one of multiple sessions is harmless', () => {
  assert.deepEqual(observe('tcp-server', {status:{event:'disconnect',_session:{type:'tcp',id:'a'},text:'1 connections'}}), {ready:true});
  assert.deepEqual(observe('tcp-server', {status:{event:'disconnect',_session:{type:'tcp',id:'b'},text:'0 个连接'}}), {unavailable:'immediate',requiresSample:true});
  assert.deepEqual(observe('tcp-server', {status:{fill:'red',text:'0 other error'}}), {});
  assert.deepEqual(observe('tcp-client', {status:{text:'common.status.disconnected'}}), {unavailable:'immediate'});
});

test('OPC session/transport failures are separated from bad individual points and security validation failures', () => {
  for (const status of ['session closed','disconnected','reconnect']) assert.equal(observe('opcua', {status}).unavailable, 'candidate');
  for (const status of ['BadNodeIdUnknown','invalid certificate','error']) assert.deepEqual(observe('opcua', {status}), {});
  assert.equal(observe('opcua-secure', {error:{code:'OPCUA_RECONNECTING',message:'OPC UA client is reconnecting'}}).unavailable, 'candidate');
  assert.equal(observe('opcua-secure', {error:{message:'BadConnectionClosed'}}).unavailable, 'immediate');
  for (const code of ['OPCUA_QUEUE_FULL','BadNodeIdUnknown','BadCertificateUntrusted','BadUserAccessDenied']) assert.deepEqual(observe('opcua-secure', {error:{code,message:code}}), {});
});

test('connectionless push ignores listener/network statuses and requires its separately configured silence rule', () => {
  assert.deepEqual(observe('push', {status:{text:'offline',fill:'red'},error:{message:'ECONNREFUSED'}}), {});
});
test('secure native connect failure preserves its explicit OPC transport meaning when done(error) loses code',()=>{
 assert.deepEqual(observe('opcua-secure',{error:{message:'Error: Connect failed: BadConnectionRejected'}}),{unavailable:'immediate'});
 assert.deepEqual(observe('opcua-secure',{error:{message:'Error: Connect failed: BadCertificateUntrusted'}}),{unavailable:'candidate'});
});
test('secure session establishment security failures are explicit candidates, excluding point, queue and unrelated errors',()=>{
 for(const status of ['BadCertificateRevocationUnknown','BadCertificateUntrusted','BadCertificateUriInvalid','BadSecurityChecksFailed','BadIdentityTokenRejected','BadUserAccessDenied']){
  assert.deepEqual(observe('opcua-secure',{error:{message:'Error: Connect failed: '+status}}),{unavailable:'candidate'});
  assert.deepEqual(observe('opcua-secure',{error:{message:'Connect failed: '+status}}),{unavailable:'candidate'});
  assert.deepEqual(observe('opcua-secure',{error:{message:'Read failed: '+status}}),{});
 }
 for(const status of ['OPCUA_QUEUE_FULL','OPCUA_QUEUE_TIMEOUT','BadNodeIdUnknown','BadNotReadable','BadTimeout','BadUnexpectedError'])assert.deepEqual(observe('opcua-secure',{error:{message:'Connect failed: '+status}}),{});
});
