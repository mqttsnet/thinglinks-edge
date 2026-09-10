/* global process, console, URL, Buffer */
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { NodeStore } from '/repo/apps/manager/src/core/nodes/store.ts';
import { buildPackument } from '/repo/apps/manager/src/core/nodes/packument.ts';
const store=new NodeStore('/tmp/serial-registry');
for(const file of await readdir('/seed'))if(file.endsWith('.tgz'))store.add(await readFile(`/seed/${file}`));
const origin=process.env.LAB_REGISTRY_ORIGIN||'http://registry:2080/';
createServer((req,res)=>{
 try {
  const path=decodeURIComponent(new URL(req.url,'http://registry').pathname.slice(1));
  if(path==='healthz'){res.end('ok');return;}
  const split=path.indexOf('/-/');
  if(split>=0){const name=path.slice(0,split),file=path.slice(split+3);const version=store.versions(name).find(v=>file.endsWith(`-${v}.tgz`));const bytes=version?store.tarball(name,version):undefined;if(!bytes){res.writeHead(404);res.end();return;}res.end(Buffer.from(bytes));return;}
  const pack=buildPackument(store,path,origin);if(!pack){res.writeHead(404);res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify(pack));
 }catch{res.writeHead(500);res.end('registry-error');}
}).listen(2080,'0.0.0.0',()=>console.log('SERIAL_REGISTRY_READY'));
