/* global process, console */
import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';const {validatedBindingArtifact}=createRequire(import.meta.url)('./artifact.cjs');
const run=promisify(execFile),s=JSON.parse(await readFile(process.argv[2],'utf8')),here=dirname(fileURLToPath(import.meta.url));
const c=JSON.parse((await run('docker',['inspect',s.instanceId])).stdout)[0];assert.equal(c.Id,s.instanceId);assert.equal(c.Image,s.imageId);assert.equal(c.Config.Labels['com.mqttsnet.thinglinks-edge.serial-lab'],s.label);
const out=join(s.directory,'device-fixture');await mkdir(join(out,'lib'),{recursive:true});await mkdir(join(out,'bin'),{recursive:true});
for(const file of ['fixture.cjs','native-probe.cjs','wire.cjs','prepare-managed.cjs'])await copyFile(join(here,file),join(out,file));
for(const [src,dst] of [['/usr/bin/socat','bin/socat'],['/usr/lib/libreadline.so.8','lib/libreadline.so.8'],['/usr/lib/libssl.so.3','lib/libssl.so.3'],['/usr/lib/libcrypto.so.3','lib/libcrypto.so.3'],['/usr/lib/libncursesw.so.6','lib/libncursesw.so.6']])await run('docker',['cp','-L',`${s.instanceId}:${src}`,join(out,dst)]);
const probed=(await run('docker',['exec',s.instanceId,'node','/opt/rtu-lab/native-probe.cjs'])).stdout.trim().split('\n').map(line=>JSON.parse(line)).find(item=>item.event==='NATIVE_LOADED');
const binary=validatedBindingArtifact(probed);
await run('docker',['cp',`${s.instanceId}:${binary}`,join(out,'bindings-10.8.0-arm64-musl.node')]);
assert.equal(createHash('sha256').update(await readFile(join(out,'bindings-10.8.0-arm64-musl.node'))).digest('hex'),probed.nativeBinaryHash);
const paths=['fixture.cjs','native-probe.cjs','wire.cjs','prepare-managed.cjs','bin/socat','lib/libreadline.so.8','lib/libssl.so.3','lib/libcrypto.so.3','lib/libncursesw.so.6','bindings-10.8.0-arm64-musl.node'];
const hashes={};for(const path of paths)hashes[path]=createHash('sha256').update(await readFile(join(out,path))).digest('hex');
await writeFile(join(out,'manifest.json'),JSON.stringify({sourceImage:s.imageId,nativeSource:probed,baseImage:'nodered/node-red:5.0.4-24-minimal',platform:'linux/arm64-musl',node:'24.18.1',modbus:'5.60.2',serialFork:'8.4.0',serialport:'10.5.0',bindings:'10.8.0',hashes},null,2)+'\n');console.log(out);
