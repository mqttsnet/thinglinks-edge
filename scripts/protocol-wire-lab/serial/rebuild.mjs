/* global process, console */
import {readFile,writeFile} from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {dirname} from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const run=promisify(execFile),file=process.argv[2],s=JSON.parse(await readFile(file,'utf8')),key='com.mqttsnet.thinglinks-edge.serial-lab';
const docker=async args=>(await run('docker',args,{maxBuffer:16*1024*1024})).stdout.trim();
const save=()=>writeFile(file,JSON.stringify(s,null,2)+'\n');
assert.match(s.label,/^srl-[a-f0-9-]{36}$/);assert.match(s.instanceId,/^[a-f0-9]{64}$/);
const old=JSON.parse(await docker(['inspect',s.instanceId]))[0];assert.equal(old.Config.Labels[key],s.label);assert.equal(old.Name,'/'+s.label+'-node-red');
await run('docker',['build','--label',`${key}=${s.label}`,'-t',s.imageTag,dirname(fileURLToPath(import.meta.url))],{env:{...process.env,BUILDX_CONFIG:'/tmp/tle-serial-buildx'},maxBuffer:16*1024*1024});
s.imageId=await docker(['image','inspect',s.imageTag,'--format','{{.Id}}']);
await docker(['rm','-f',s.instanceId]);(s.retiredContainers??=[]).push(s.instanceId);s.containers=s.containers.filter(id=>id!==s.instanceId);await save();
s.instanceId=await docker(['create','--name',s.label+'-node-red','--label',`${key}=${s.label}`,'--network',s.network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','1g','--cpus','1','--pids-limit','512','--tmpfs','/tmp:rw,noexec,nosuid,size=256m','--mount',`type=bind,src=${s.directory}/data,dst=/data`,'--publish','127.0.0.1::1880','--env','npm_config_nodedir=/usr/local',s.imageId]);s.containers.push(s.instanceId);await save();await docker(['start',s.instanceId]);
const c=JSON.parse(await docker(['inspect',s.instanceId]))[0];s.url='http://127.0.0.1:'+c.NetworkSettings.Ports['1880/tcp'][0].HostPort;await save();console.log(JSON.stringify({url:s.url,instanceId:s.instanceId,imageId:s.imageId}));
