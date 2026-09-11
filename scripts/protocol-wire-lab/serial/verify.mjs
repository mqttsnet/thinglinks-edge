#!/usr/bin/env node
/* global process, console, fetch, AbortSignal, setTimeout */
import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const s=JSON.parse(await readFile(process.argv[2],'utf8')),run=promisify(execFile);
const info=JSON.parse((await run('docker',['inspect',s.instanceId])).stdout)[0];assert.equal(info.Config.Labels['com.mqttsnet.thinglinks-edge.serial-lab'],s.label);assert.equal(info.Id,s.instanceId);assert.equal(info.Image,s.imageId);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function request(path,body){const r=await fetch(s.url+path,{...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});assert.equal(r.ok,true,await r.text().then(text=>{if(!r.ok)return text;return '';}));return body===undefined?JSON.parse(await (await fetch(s.url+path)).text()):true;}
const state=()=>fetch(s.url+'/lab/state',{signal:AbortSignal.timeout(10000)}).then(r=>r.json());
async function wait(name,fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await fn())return;}catch{/* bounded startup or reconnect */}await sleep(200);}throw Error('Timed out: '+name);}
await wait('startup',async()=> (await state()).nativeOpened,240000);
const flows=[
 {id:'rtu-tab',type:'tab',label:'RTU 串口字节验收',disabled:false},
 {id:'rtu-client',type:'modbus-client',name:'正式串口客户端',clienttype:'serial',serialPort:'/tmp/tle-rtu-collector',serialType:'RTU-BUFFERD',serialBaudrate:9600,serialDatabits:8,serialStopbits:1,serialParity:'none',serialConnectionDelay:100,unit_id:1,bufferCommands:true,parallelUnitIdsAllowed:false,commandDelay:100,clientTimeout:1500,reconnectOnTimeout:true,reconnectTimeout:500,stateLogEnabled:false,queueLogEnabled:false,failureLogEnabled:true},
 {id:'rtu-read',type:'modbus-read',z:'rtu-tab',name:'读取真实RTU寄存器',unitid:'1',dataType:'HoldingRegister',adr:'0',quantity:'2',rate:'1',rateUnit:'s',delayOnStart:true,startDelayTime:1,server:'rtu-client',useIOFile:false,useIOForPayload:false,emptyMsgOnFail:false,enableDeformedMessages:false,showErrors:true,showWarnings:true,x:170,y:120,wires:[['rtu-raw','rtu-calc'],[]]},
 {id:'rtu-raw',type:'rtu-observer',z:'rtu-tab',name:'原始寄存器证据',kind:'raw',x:500,y:60,wires:[]},
 {id:'rtu-calc',type:'function',z:'rtu-tab',name:'倍率0.1 + 偏移1',func:'msg.payload={temperature:msg.payload[0]*0.1+1}; return msg;',outputs:1,libs:[],x:490,y:160,wires:[['rtu-computed']]},
 {id:'rtu-computed',type:'rtu-observer',z:'rtu-tab',name:'换算值证据',kind:'computed',x:790,y:160,wires:[]},
];
const installed=await fetch(s.url+'/nodes',{headers:{accept:'application/json'}}).then(r=>r.json());
await writeFile(s.directory+'/node-inventory.json',JSON.stringify(installed,null,2));
await writeFile(s.directory+'/flows.json',JSON.stringify(flows,null,2));
await request('/flows',flows);await request('/lab/state',{raw:250,mode:'none',connected:true});
await wait('250->26',async()=>{const x=await state();return x.outputs.some(o=>o.kind==='raw'&&o.payload[0]===250)&&x.outputs.some(o=>o.kind==='computed'&&o.payload.temperature===26);});
await request('/lab/state',{raw:375});
await wait('375->38.5',async()=>{const x=await state();return x.outputs.some(o=>o.kind==='raw'&&o.payload[0]===375)&&x.outputs.some(o=>o.kind==='computed'&&o.payload.temperature===38.5);});
const faults=[];
for(const mode of ['bad-crc','wrong-unit','truncated']){
 await request('/lab/state',{mode,raw:620});await sleep(2500);const from=Date.now();await sleep(3000);const x=await state();assert.equal(x.outputs.filter(o=>o.at>=from).length,0,`${mode} produced data`);faults.push({mode,from,to:Date.now(),newOutputs:0});
 await request('/lab/state',{mode:'none',raw:375});await wait(mode+' recovery',async()=> (await state()).outputs.some(o=>o.at>=from&&o.kind==='computed'&&o.payload.temperature===38.5),30000);
}
await request('/lab/state',{connected:false});await sleep(2500);const stopped=Date.now();await sleep(3000);assert.equal((await state()).outputs.filter(o=>o.at>=stopped).length,0);faults.push({mode:'disconnected',from:stopped,to:Date.now(),newOutputs:0});
await request('/lab/state',{connected:true,raw:375});await wait('PTY reconnect recovery',async()=> (await state()).outputs.some(o=>o.at>=stopped&&o.kind==='computed'&&o.payload.temperature===38.5),30000);
const final=await state();assert.ok(final.frames.some(f=>f.direction==='request'&&f.hex==='010300000002c40b'&&f.crcValid));assert.ok(final.frames.some(f=>f.direction==='response'&&f.mode==='none'&&f.crcValid));
const report={at:new Date().toISOString(),instanceId:s.instanceId,imageId:s.imageId,url:s.url,nativeOpened:final.nativeOpened,rawAndComputed:[[250,26],[375,38.5]],faults,frames:final.frames,outputs:final.outputs};await writeFile(s.directory+'/verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify({result:'SERIAL_RTU_VERIFIED',report:s.directory+'/verification.json',url:s.url,faults:faults.length}));
