/** Build only explicit, immutable Node-RED / Node 24 musl release profiles. */
import {resolveBuildProfile} from './profiles.mjs';
import console from 'node:console';
const {fetch,AbortController}=globalThis;
import process from 'node:process';
import {Buffer} from 'node:buffer';
import {URL,fileURLToPath} from 'node:url';
import {readFile,writeFile,mkdtemp,cp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout,clearTimeout} from 'node:timers';
const directory=fileURLToPath(new URL('.',import.meta.url));
const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
const args=process.argv.slice(2);
const get=name=>args.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
if(args.some(arg=>!/^--(?:arch|tag|archive|profile)=.+$/.test(arg)))throw Error('Use --arch=arm64|x64 --tag=local-image:unique-tag [--profile=5.0.4-24-minimal] [--archive=official-package.tgz]');
const arch=get('arch'),tag=get('tag'),archive=get('archive');
if(!['arm64','x64'].includes(arch)||!tag||!/^[-a-z0-9./]+:[-a-zA-Z0-9_.]+$/.test(tag))throw Error('Explicit supported architecture and local image tag required');
const profile=resolveBuildProfile(get('profile')??'5.0.4-24-minimal',arch);
const context=await mkdtemp(join(tmpdir(),'tle-opcua-native-build-'));
try{
 let bytes;
 if(archive)bytes=await readFile(archive);
 else{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
  try{
   const response=await fetch(manifest.packageUrl,{signal:controller.signal});if(!response.ok)throw Error('Official package download failed');
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>8*1024*1024)throw Error('Official package exceeded pinned size budget');chunks.push(chunk);}bytes=Buffer.concat(chunks);
  }finally{clearTimeout(timer);controller.abort();}
 }
 if('sha512-'+createHash('sha512').update(bytes).digest('base64')!==manifest.packageIntegrity)throw Error('Official package integrity mismatch');
 await writeFile(join(context,'package.tgz'),bytes);await cp(directory,join(context,'scripts'),{recursive:true});
 const code=await new Promise((resolve,reject)=>{const child=spawn('docker',['build','--platform',arch==='arm64'?'linux/arm64':'linux/amd64','--build-arg','NODE_RED_BASE='+profile.baseImage,'--build-arg','NODE_RED_PROFILE='+profile.name,'--build-arg','TOOLCHAIN_LOCK='+profile.toolchainFile,'-f',join(context,'scripts/Dockerfile'),'-t',tag,context],{stdio:'inherit'});child.once('error',reject);child.once('exit',(status,signal)=>signal?reject(Error('Native build interrupted')):resolve(status));});
 if(code!==0)throw Error('Native build failed; no verified runtime image was produced');
 console.log(`Built ${tag} for ${arch}; original @tier0/opcua-client@0.6.0 package and its approval are unchanged.`);
}finally{await rm(context,{recursive:true,force:true});}
