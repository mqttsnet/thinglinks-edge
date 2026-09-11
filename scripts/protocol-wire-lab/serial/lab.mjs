#!/usr/bin/env node
/* global process, console */
import { registrySourceMounts } from '../../protocol-fixtures/source-mounts.mjs';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFile,writeFile,mkdir,mkdtemp,chmod} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {resolve,dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import {tmpdir} from 'node:os';import assert from 'node:assert/strict';
const run=promisify(execFile),here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../..'),key='com.mqttsnet.thinglinks-edge.serial-lab';
const docker=async args=>(await run('docker',args,{maxBuffer:16*1024*1024})).stdout.trim();
const save=(file,state)=>writeFile(file,JSON.stringify(state,null,2)+'\n');
export async function cleanup(file){const s=JSON.parse(await readFile(file,'utf8'));assert.match(s.label,/^srl-[a-f0-9-]{36}$/);for(const id of [...s.containers].reverse()){assert.match(id,/^[a-f0-9]{64}$/);const c=JSON.parse(await docker(['inspect',id]))[0];assert.equal(c.Config.Labels[key],s.label);await docker(['rm','-f',id]);}if(s.network){const n=JSON.parse(await docker(['network','inspect',s.network]))[0];assert.equal(n.Labels[key],s.label);assert.equal(Object.keys(n.Containers).length,0);await docker(['network','rm',s.network]);}}
async function create(file){
 let s;if(file)s=JSON.parse(await readFile(file,'utf8'));else{const label='srl-'+randomUUID(),directory=await mkdtemp(join(tmpdir(),'tle-serial-'));s={label,directory,containers:[],network:null,imageTag:'tle-rtu-lab:'+label,before:(await docker(['ps','-aq','--no-trunc'])).split('\n').filter(Boolean)};file=join(directory,'state.json');await mkdir(join(directory,'data'));await chmod(join(directory,'data'),0o777);await save(file,s);}
 assert.equal(s.containers.length,0);assert.equal(s.network,null);
 console.log(`STATE_FILE ${file}`);
 await run('docker',['build','--label',`${key}=${s.label}`,'-t',s.imageTag,here],{env:{...process.env,BUILDX_CONFIG:'/tmp/tle-serial-buildx'},maxBuffer:16*1024*1024});
 s.imageId=await docker(['image','inspect',s.imageTag,'--format','{{.Id}}']);await save(file,s);
 s.subnet=process.env.SERIAL_LAB_SUBNET||'10.253.240.0/28';
 s.network=await docker(['network','create','--subnet',s.subnet,'--label',`${key}=${s.label}`,s.label]);await save(file,s);
 const registry=await docker(['create','--name',s.label+'-registry','--label',`${key}=${s.label}`,'--network',s.network,'--network-alias','registry','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,size=512m',...registrySourceMounts(root),'--mount',`type=bind,src=${root}/dist-nodes/protocols,dst=/seed,readonly`,'node:24.19.0-alpine','node','--experimental-strip-types','/repo/scripts/protocol-wire-lab/serial/registry.mjs']);
 s.containers.push(registry);await save(file,s);await docker(['start',registry]);
 s.instanceId=await docker(['create','--name',s.label+'-node-red','--label',`${key}=${s.label}`,'--network',s.network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','1g','--cpus','1','--pids-limit','512','--tmpfs','/tmp:rw,noexec,nosuid,size=256m','--mount',`type=bind,src=${s.directory}/data,dst=/data`,'--publish','127.0.0.1::1880','--env','npm_config_nodedir=/usr/local',s.imageId]);
 s.containers.push(s.instanceId);await save(file,s);await docker(['start',s.instanceId]);
 const c=JSON.parse(await docker(['inspect',s.instanceId]))[0];s.url='http://127.0.0.1:'+c.NetworkSettings.Ports['1880/tcp'][0].HostPort;await save(file,s);
 console.log(JSON.stringify({stateFile:file,url:s.url,instanceId:s.instanceId,network:s.network}));
}
if(process.argv[2]==='cleanup')await cleanup(process.argv[3]);else await create(process.argv[2]);
