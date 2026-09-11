/* global process, console, Buffer, setTimeout, clearTimeout, URL, __dirname */
const fs=require('node:fs');const {join}=require('node:path');const http=require('node:http');const {spawn,execFileSync}=require('node:child_process');const {createRequire}=require('node:module');
const {describeFrame,corruptResponse}=require('./wire.cjs');
const fromLab=createRequire(process.env.LAB_MODULE_PACKAGE||'/data/runtime/package.json');
const evidence=process.env.LAB_EVIDENCE_DIR||'/data/evidence';fs.mkdirSync(evidence,{recursive:true});
const serverOnly=process.env.LAB_SERVER_ONLY==='1';
let ServerSerial;
const RED=serverOnly?null:require('/usr/src/node-red/node_modules/node-red');
const collector=process.env.LAB_COLLECTOR_PATH||'/tmp/tle-rtu-collector',device=process.env.LAB_DEVICE_PATH||'/tmp/tle-rtu-device';
const state={raw:250,mode:'none',connected:false,frames:[],outputs:[],errors:[],nativeOpened:false};
const append=(file,value)=>fs.appendFileSync(`${evidence}/${file}.jsonl`,JSON.stringify({at:new Date().toISOString(),...value})+'\n');
const capture=(direction,bytes)=>{const value={at:Date.now(),direction,mode:state.mode,...describeFrame(bytes)};state.frames.push(value);if(state.frames.length>1000)state.frames.shift();append('wire',value);};
let relay,serial,resetTimer;
async function openWire(){
 const relayLog=fs.openSync(join(evidence,'socat.log'),'a');
 relay=spawn(process.env.LAB_SOCAT||'/usr/bin/socat',['-d','-d','-x','-v',`PTY,raw,echo=0,sitout-eio=5,link=${collector}`,`PTY,raw,echo=0,sitout-eio=5,link=${device}`],{stdio:['ignore','ignore',relayLog],env:{...process.env,...(process.env.LAB_LIBRARY_PATH?{LD_LIBRARY_PATH:process.env.LAB_LIBRARY_PATH}:{})}});fs.closeSync(relayLog);
 for(let i=0;i<100;i++){if(fs.existsSync(collector)&&fs.existsSync(device))break;await new Promise(r=>setTimeout(r,30));}
 if(!state.nativeOpened){
  try{execFileSync('node',[join(__dirname,'native-probe.cjs'),collector],{stdio:['ignore',fs.openSync(join(evidence,'native-pty.jsonl'),'a'),fs.openSync(join(evidence,'native-pty.jsonl'),'a')]});}
  catch(error){
   append('native-pty-failure',{status:error.status,signal:error.signal});
   if(serverOnly)throw new Error('原生串口验证失败；server-only模式不会修改现有依赖，请核对已交付的同版本musl产物',{cause:error});
   const log=fs.openSync(join(evidence,'native-rebuild.log'),'a');
   execFileSync('npm',['rebuild','--prefix','/data/runtime','--build-from-source','@serialport/bindings-cpp'],{stdio:['ignore',log,log]});
   fs.writeFileSync(join(evidence,'native-build-mode.txt'),'same-source-musl-rebuild-after-PTY-open-failure\n');
   execFileSync('node',[join(__dirname,'native-probe.cjs'),collector],{stdio:['ignore',fs.openSync(join(evidence,'native-pty-after.jsonl'),'a'),fs.openSync(join(evidence,'native-pty-after.jsonl'),'a')]});
  }
  state.nativeOpened=true;
 }
 ServerSerial??=fromLab('@openp4nr/modbus-serial').ServerSerial;
 serial=new ServerSerial({getHoldingRegister:address=>address===0?state.raw:65,getInputRegister:address=>address===0?state.raw:65},{path:device,baudRate:9600,unitID:1,interval:30},{dataBits:8,stopBits:1,parity:'none'});
 const port=serial.getPort();port.on('data',bytes=>capture('request',bytes));port.on('error',error=>{state.errors.push(error.message);append('errors',{source:'serial',message:error.message});});
 const write=port.write.bind(port);port.write=(bytes,...args)=>{const response=corruptResponse(Buffer.from(bytes),state.mode);capture('response',response);return write(response,...args);};
 serial.on('error',error=>append('errors',{source:'server',message:error.message}));state.connected=true;
}
async function closeWire(){state.connected=false;if(serial){await new Promise(r=>serial.getPort().close(()=>r()));serial=undefined;}if(relay){const child=relay;relay=undefined;if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;}}}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://lab');
 if(url.pathname==='/lab/shutdown'&&req.method==='POST'){res.writeHead(202);res.end('stopping');setTimeout(()=>{void close();},20);return;}
 if(url.pathname==='/lab/state'&&req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify(state));return;}
 if(url.pathname==='/lab/state'&&req.method==='POST'){
  try{let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)throw Error('body too large');}const input=JSON.parse(body);if(input.raw!==undefined){if(!Number.isInteger(input.raw)||input.raw<0||input.raw>65535)throw Error('invalid raw');state.raw=input.raw;}
   if(input.mode!==undefined){if(!['none','bad-crc','wrong-unit','truncated'].includes(input.mode))throw Error('invalid mode');state.mode=input.mode;}
   if(input.connected===false)await closeWire();if(input.connected===true&&!state.connected)await openWire();
   if(input.durationMs!==undefined){if(!Number.isInteger(input.durationMs)||input.durationMs<100||input.durationMs>30000)throw Error('duration 100..30000');clearTimeout(resetTimer);resetTimer=setTimeout(()=>{state.mode='none';},input.durationMs);}
   res.end(JSON.stringify({ok:true,raw:state.raw,mode:state.mode,connected:state.connected}));
  }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error.message}));}return;
 }
 if(url.pathname.startsWith('/lab/')){res.writeHead(404);res.end();return;}
 if(RED)RED.httpAdmin(req,res);else{res.writeHead(404);res.end();}
});
function captureNode(config){RED.nodes.createNode(this,config);this.on('input',msg=>{const value={at:Date.now(),kind:config.kind,payload:msg.payload};state.outputs.push(value);if(state.outputs.length>500)state.outputs.shift();append('outputs',value);});}
async function main(){
 await openWire();
 if(serverOnly){await new Promise(r=>server.listen(Number(process.env.LAB_PORT||1881),'0.0.0.0',r));console.log('SERIAL_DEVICE_READY');return;}
 RED.init(server,{userDir:'/data/nodered',httpAdminRoot:'/',httpNodeRoot:'/api',uiPort:1880,credentialSecret:'isolated-serial-lab-only',functionExternalModules:false,nodesExcludes:['90-exec.js','10-file.js','28-tail.js','23-watch.js'],editorTheme:{projects:{enabled:false}},logging:{console:{level:'warn',metrics:false,audit:false}}});
 RED.nodes.registerType('serial-lab','rtu-observer',captureNode);
 await RED.start();await new Promise(r=>server.listen(1880,'0.0.0.0',r));
 console.log('SERIAL_LAB_READY');
}
async function close(){clearTimeout(resetTimer);if(RED)await RED.stop();await closeWire();server.close(()=>process.exit(0));}
process.on('SIGTERM',()=>{void close();});process.on('SIGINT',()=>{void close();});
main().catch(error=>{console.error(error);process.exit(1);});
