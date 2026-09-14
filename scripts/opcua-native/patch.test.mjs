import {Buffer} from 'node:buffer';
import {URL} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {applyChainFix} from './patch.mjs';
const fixture=new URL('./fixtures/ua_client_connect-v1.4.16.c',import.meta.url);
test('pinned upstream source is patched only at certificate identity checks',async()=>{
 const source=await readFile(fixture);
 const patched=applyChainFix(source).toString();
 assert.match(patched,/channelModule\.compareCertificate\(\s*channel->channelContext, &asymHeader->senderCertificate\)/);
 assert.match(patched,/channelModule\.compareCertificate\(\s*client->channel.channelContext, &sessionResponse->serverCertificate\)/);
 assert.ok(patched.includes('checkCreateSessionSignature(client, &client->channel, sessionResponse)'));
 assert.ok(patched.includes('compareCertificateThumbprint(sp, &asymHeader->receiverCertificateThumbprint)'));
 assert.throws(()=>applyChainFix(Buffer.from(patched)),/source digest/);
 const changed=Buffer.from(source);changed[0]^=1;assert.throws(()=>applyChainFix(changed),/source digest/);
});
