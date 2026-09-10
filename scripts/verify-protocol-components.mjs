#!/usr/bin/env node
/* global process, console, fetch, AbortSignal, Buffer, setTimeout, URL */
/** Isolated offline install/load acceptance. Never uses a managed production instance. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile, chmod, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROTOCOL_PACKAGE_PINS } from '../apps/manager/src/core/protocols/catalog.ts';
import { PLATFORM_NODE_PACKAGE, PLATFORM_COMMON_PACKAGE, PLATFORM_NODE_TYPES } from '../apps/manager/src/core/nodes/platform-contract.ts';
import { NodeStore } from '../apps/manager/src/core/nodes/store.ts';
import { buildPackument } from '../apps/manager/src/core/nodes/packument.ts';
import { verifyProtocolSeed } from './prepare-protocol-seed.mjs';
import { registrySourceMounts } from './protocol-fixtures/source-mounts.mjs';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const labelKey = 'com.mqttsnet.thinglinks-edge.protocol-verification';
const docker = async (args) => (await run('docker',args,{maxBuffer:8*1024*1024})).stdout.trim();
const snapshot = (ids) => ids.length ? docker(['inspect','--format',
  '{{.Id}} {{.Image}} {{.State.StartedAt}} {{.State.Running}}',...ids]) : Promise.resolve('');
const wait = async (name, probe, timeout=60_000) => {
  const until=Date.now()+timeout;
  while(Date.now()<until) { try { const value=await probe(); if(value)return value; } catch { /* bounded readiness */ }
    await new Promise((resolve)=>setTimeout(resolve,250)); }
  throw new Error(`Timed out: ${name}`);
};

async function registry() {
  const store=new NodeStore('/tmp/protocol-registry');
  for(const directory of ['/seed','/platform'])for(const file of await readdir(directory)) {
    if(file.endsWith('.tgz'))store.add(await readFile(join(directory,file)));
  }
  const cache=new Map();
  createServer((req,res)=>{
    try {
      const path=decodeURIComponent(new URL(req.url,'http://registry').pathname.slice(1));
      if(path==='healthz'){res.end('ok');return;}
      const split=path.indexOf('/-/');
      if(split>=0) {
        const module=path.slice(0,split), file=path.slice(split+3);
        const version=store.versions(module).find((v)=>file.endsWith(`-${v}.tgz`));
        const bytes=version?store.tarball(module,version):undefined;
        if(!bytes){res.writeHead(404);res.end();return;}
        res.setHeader('content-type','application/octet-stream');res.end(bytes);return;
      }
      if(!cache.has(path))cache.set(path,buildPackument(store,path,'http://registry:2080/'));
      const doc=cache.get(path);
      if(!doc){res.writeHead(404);res.end();return;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify(doc));
    }catch {res.writeHead(500);res.end('registry failure');}
  }).listen(2080,'0.0.0.0',()=>console.log('PROTOCOL_REGISTRY_READY'));
}

export function validateVerificationState(state) {
  assert.match(state.label,/^pt3-[0-9a-f-]{36}$/,'invalid verification owner');
  assert.ok(Array.isArray(state.containers),'missing captured container ids');
  assert.ok(state.containers.every((id)=>typeof id==='string' && /^[0-9a-f]{64}$/.test(id)),'invalid captured container id');
  assert.equal(new Set(state.containers).size,state.containers.length,'duplicate captured container ids');
  if(state.beforeIds!==undefined) {
    assert.ok(Array.isArray(state.beforeIds) && state.beforeIds.every((id)=>typeof id==='string' && /^[0-9a-f]{12,64}$/.test(id)),
      'invalid original container ids');
    assert.equal(typeof state.beforeSnapshot,'string','missing original container snapshot');
  }
  for(const id of [state.network,state.accessNetwork].filter((value)=>value!==null && value!==undefined)) {
    assert.match(id,/^[0-9a-f]{64}$/,'invalid captured network id');
  }
}

export async function cleanupProtocolVerification(state) {
  validateVerificationState(state);
  for(const id of [...state.containers].reverse()) {
    const info=JSON.parse(await docker(['inspect',id]))[0];
    assert.equal(info.Config.Labels[labelKey],state.label,'refusing to remove unowned container');
    await docker(['rm','-f',id]);
  }
  for(const network of [state.accessNetwork,state.network].filter(Boolean)) {
    const info=JSON.parse(await docker(['network','inspect',network]))[0];
    assert.equal(info.Labels[labelKey],state.label,'refusing to remove unowned network');
    assert.equal(Object.keys(info.Containers).length,0,'owned network still has containers');
    await docker(['network','rm',network]);
  }
  if(state.beforeIds)assert.equal(await snapshot(state.beforeIds),state.beforeSnapshot,'pre-existing container state changed');
}

async function main() {
  if(process.argv[2]==='--cleanup') {
    const file=process.argv[3];assert.ok(file,'cleanup requires an exact state file');
    const state=JSON.parse(await readFile(file,'utf8'));await cleanupProtocolVerification(state);
    console.log('Protocol verification resources cleaned');return;
  }
  assert.ok(process.argv.slice(2).every((arg)=>arg==='--keep'),'usage: --keep or --cleanup state.json');
  const keep=process.argv.includes('--keep');
  const seed=join(root,'dist-nodes/protocols');
  const manifest=await verifyProtocolSeed(seed);
  const directory=await realpath(await mkdtemp(join(tmpdir(),'tle-protocol-verification-')));
  const data=join(directory,'data'),platform=join(directory,'platform');
  await mkdir(data);await chmod(data,0o777);await mkdir(platform);
  const image='nodered/node-red:5.0.4-24-minimal';
  const runtimeImage='node:24.19.0-alpine';
  await docker(['image','inspect',image]);await docker(['image','inspect',runtimeImage]);
  const before=await docker(['ps','-aq']);
  const beforeIds=before.split('\n').filter(Boolean);
  const label=`pt3-${randomUUID()}`;
  const state={label,containers:[],network:null,directory,seedArchives:manifest.packages.length,
    beforeIds,beforeSnapshot:await snapshot(beforeIds)};
  const stateFile=join(directory,'state.json');
  const persist=()=>writeFile(stateFile,JSON.stringify(state,null,2)+'\n');
  await persist();
  try {
    for(const pin of [PLATFORM_NODE_PACKAGE,PLATFORM_COMMON_PACKAGE]) {
      const metaRes=await fetch(`https://registry.npmjs.org/${encodeURIComponent(pin.name)}/${pin.version}`,{signal:AbortSignal.timeout(60_000)});
      assert.equal(metaRes.status,200);const meta=await metaRes.json();
      const response=await fetch(meta.dist.tarball,{signal:AbortSignal.timeout(60_000)});assert.equal(response.status,200);
      const bytes=Buffer.from(await response.arrayBuffer());
      assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`,pin.integrity);
      await writeFile(join(platform,`${pin.name.replace(/^@/,'').replaceAll('/','-')}-${pin.version}.tgz`),bytes);
    }
    state.network=await docker(['network','create','--internal','--label',`${labelKey}=${label}`,label]);await persist();
    const registryId=await docker(['create','--name',`${label}-registry`,'--network',state.network,'--network-alias','registry',
      '--label',`${labelKey}=${label}`,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
      '--tmpfs','/tmp:rw,nosuid,size=512m',...registrySourceMounts(root),
      '--mount',`type=bind,src=${seed},dst=/seed,readonly`,'--mount',`type=bind,src=${platform},dst=/platform,readonly`,
      runtimeImage,'node','--experimental-strip-types','/repo/scripts/verify-protocol-components.mjs','--registry']);
    state.containers.push(registryId);await persist();await docker(['start',registryId]);
    await wait('offline registry',async()=> (await docker(['logs',registryId])).includes('PROTOCOL_REGISTRY_READY'));
    const pins=[...PROTOCOL_PACKAGE_PINS,{module:PLATFORM_NODE_PACKAGE.name,version:PLATFORM_NODE_PACKAGE.version,nodeTypes:[...PLATFORM_NODE_TYPES]}];
    const settings={uiPort:1880,httpAdminRoot:'/',httpNodeRoot:'/api/',credentialSecret:'isolated-test-only',
      functionExternalModules:false,externalModules:{autoInstall:false,palette:{allowInstall:true,
        allowList:pins.map((p)=>`${p.module}@${p.version}`),denyList:['*'],allowUpload:false,allowUpdate:false}},
      editorTheme:{palette:{catalogues:[]}}};
    await writeFile(join(data,'settings.js'),`module.exports=${JSON.stringify(settings,null,2)};\n`);
    const instanceId=await docker(['create','--name',`${label}-node-red`,'--network',state.network,
      '--label',`${labelKey}=${label}`,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
      '--tmpfs','/tmp:rw,nosuid,size=256m','--mount',`type=bind,src=${data},dst=/data`,
      '--publish','127.0.0.1::1880','--env','NPM_CONFIG_REGISTRY=http://registry:2080/',
      '--env','TLE_MANAGER_URL=http://127.0.0.1:19101','--env','TLE_INGEST_TOKEN=protocol-fixture-only',
      '--env','TLE_INSTANCE_ID=protocol-fixture','--env','XDG_CONFIG_HOME=/data/.config',image]);
    state.containers.push(instanceId);state.instanceId=instanceId;await persist();await docker(['start',instanceId]);
    const info=JSON.parse(await docker(['inspect',instanceId]))[0];
    state.imageId=info.Image;await persist();
    const request=async(path,options={})=>JSON.parse(await docker(['exec',instanceId,'node','-e',
      `fetch('http://127.0.0.1:1880/'+${JSON.stringify(path)},${JSON.stringify({...options,headers:{accept:'application/json',...options.headers}})})`
      + `.then(async(r)=>console.log(JSON.stringify({status:r.status,body:await r.text()})))`
      + `.catch(()=>process.exit(1))`]));
    await wait('Node-RED admin',async()=> (await request('nodes')).status===200);
    for(const pin of pins) {
      const response=await request('nodes',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({module:pin.module,version:pin.version})});
      if(response.status!==200)throw new Error(`Offline install ${pin.module} HTTP ${response.status}: ${response.body.slice(0,600)}`);
      console.log(`Installed ${pin.module}@${pin.version}`);
    }
    const inventory=JSON.parse((await request('nodes')).body);
    for(const pin of pins) {
      const sets=inventory.filter((item)=>item.module===pin.module);
      assert.ok(sets.length,`missing module ${pin.module}`);
      assert.ok(sets.every((item)=>item.version===pin.version && item.enabled===true && !item.err),`unhealthy ${pin.module}`);
      const types=sets.flatMap((item)=>item.types??[]);
      for(const type of pin.nodeTypes)assert.ok(types.includes(type),`missing ${type}`);
    }
    assert.equal(JSON.parse(await docker(['network','inspect',state.network]))[0].Internal,true);
    assert.equal(Object.keys(JSON.parse(await docker(['inspect',instanceId]))[0].NetworkSettings.Networks).length,1);
    // Installation above is proven offline. A separate task-owned bridge exposes Admin for recipe tests only afterward.
    state.accessNetwork=await docker(['network','create','--label',`${labelKey}=${label}`,`${label}-access`]);await persist();
    await docker(['network','connect',state.accessNetwork,instanceId]);
    const port=await wait('task Admin published port',async()=>{
      const current=JSON.parse(await docker(['inspect',instanceId]))[0];
      return current.NetworkSettings.Ports['1880/tcp']?.[0]?.HostPort;
    });
    state.url=`http://127.0.0.1:${port}`;
    state.verified=true;await persist();
    console.log(`OFFLINE_PROTOCOLS_VERIFIED ${JSON.stringify({stateFile,instanceId,url:state.url,archives:manifest.packages.length,imageId:state.imageId})}`);
  } finally {
    if(!keep || !state.verified) {
      await cleanupProtocolVerification(state);
      assert.equal(await docker(['ps','-aq']),before,'pre-existing container inventory changed');
    }
  }
}

if(process.argv[2]==='--registry') await registry();
else if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
