import { TemplateError, type FlowNode } from '../types.ts';
import { observationScript, type ObservedProtocol } from './presence-observation.ts';
import { resolveServiceCode, MAX_TEMPLATE_SERVICES } from './service-mapping.ts';
import { MAX_TEMPLATE_POINTS } from './limits.ts';

export interface PresenceFlowConfig {
  nodeId: string;
  serviceCode: string;
  /** Every service in this physical acquisition is permitted on the same observer sequence. */
  serviceCodes?: string[];
  protocol: ObservedProtocol;
  silenceTimeoutMs?: number;
  /** HTTP push keeps req/res only on in-flight messages and returns 503 until an active lease exists. */
  httpResponse?: boolean;
  sourceIds: string[];
  changesOnly?: boolean;
  failureWindowMs: number;
}

// Node-RED gives each Function its own VM. Keep tickets and run state only in that VM,
// never in file-backed node/flow context or in the saved flow configuration.
// No samples are buffered during bootstrap/renew; activation always waits for a new real sample.
const INITIALIZE = `globalThis.__tlePresenceRuntime={closed:false,phase:'new',sequence:1,requestId:0,nextAttempt:0,lastRenew:0,unavailableSince:null,acceptSample:true,offlineSent:false};`;
const FINALIZE = `const s=globalThis.__tlePresenceRuntime;if(s){s.closed=true;s.pending=null;globalThis.__tlePresenceRuntime=s;}`;

const BODY = `
const s=globalThis.__tlePresenceRuntime;
const unavailable=()=>config.httpResponse&&msg.res?[null,null,{req:msg.req,res:msg.res,statusCode:503,headers:{'content-type':'application/json','retry-after':'5'},payload:{received:false,error:'采集服务暂未就绪，请稍后重试'}}]:null;
if(!s||s.closed)return unavailable();
const now=Date.now();
const save=()=>globalThis.__tlePresenceRuntime=s;
const stop=()=>{s.closed=true;s.pending=null;save();node.status({fill:'red',shape:'ring',text:'采集状态代次已失效，请重新部署'});return null;};
const validCounter=n=>Number.isSafeInteger(n)&&n>=1;
const envelope=(kind,values,services,serviceCode=config.serviceCode)=>{
 if(!s.generation||s.phase!=='active'||s.pending||now>=s.leaseExpiresAt)return null;
 if(!validCounter(s.sequence))return stop();
 const meta={version:1,observerId:node.id,runNonce:s.runNonce,generation:s.generation,sequence:s.sequence++,kind};
 if(kind==='sample'){
  const serialized=JSON.stringify(services||[{serviceCode,values}]);
  meta.report=!config.changesOnly||serialized!==s.previousValues||now-s.lastFullReport>=60000;
  if(meta.report)s.lastFullReport=now;
  s.previousValues=serialized;s.unavailableSince=null;s.consecutiveFailures=0;s.offlineSent=false;s.lastSample=now;
  save();return {nodeId:config.nodeId,serviceId:serviceCode,payload:services?{__tlePresence:meta,services}:{__tlePresence:meta,values}};
 }
 meta.online=false;s.offlineSent=true;s.lastOffline=now;s.previousValues=undefined;
 save();return {nodeId:config.nodeId,serviceId:config.serviceCode,payload:{__tlePresence:meta}};
};
const request=operation=>{
 const base=env.get('TLE_MANAGER_URL'),token=env.get('TLE_INGEST_TOKEN');
 if(!base||!token){s.nextAttempt=now+5000;save();node.status({fill:'yellow',shape:'ring',text:'等待实例接入配置'});return null;}
 const marker={runNonce:s.runNonce,id:++s.requestId,operation};
 const payload={nodeId:config.nodeId,observerId:node.id,runNonce:s.runNonce};
 if(operation==='activate')payload.ticket=s.ticket;
 else {payload.runNonce=s.runNonce;if(operation==='renew')payload.generation=s.generation;}
 s.pending={...marker,started:now};save();
 return {method:'POST',url:String(base).replace(/\\/$/,'')+'/api/edge/observers/'+operation,
 headers:{'content-type':'application/json',authorization:'Bearer '+token},requestTimeout:4000,
 payload,_tlePresenceRequest:marker};
};
if(msg._tlePresenceRequest){
 const marker=msg._tlePresenceRequest,pending=s.pending;
 if(!pending||!s.runNonce||marker.runNonce!==s.runNonce||marker.id!==pending.id||marker.operation!==pending.operation)return null;
 s.pending=null;
 if(msg.statusCode===409&&marker.operation==='activate'&&msg.payload&&msg.payload.code==='OBSERVER_TICKET_EXPIRED'){s.ticket=undefined;s.phase='challenge';s.nextAttempt=now;save();return null;}
 if(msg.statusCode===409||msg.statusCode===401||msg.statusCode===403||msg.statusCode===400)return stop();
 if(!Number.isInteger(msg.statusCode)||msg.statusCode<200||msg.statusCode>=300||!msg.payload||typeof msg.payload!=='object'){
  s.nextAttempt=now+5000;save();return null;
 }
 const body=msg.payload;
 if(marker.operation==='challenge'){
  if(typeof body.ticket!=='string'||!body.ticket||!Number.isSafeInteger(body.expiresAt)||body.expiresAt<=now)return stop();
  s.ticket=body.ticket;s.phase='activate';save();return [null,request('activate')];
 }
 if(body.observerId!==node.id||body.runNonce!==s.runNonce||!validCounter(body.generation)||!validCounter(body.nextSequence)||!Number.isSafeInteger(body.leaseExpiresAt)||body.leaseExpiresAt<=now)return stop();
 if(s.generation&&body.generation<s.generation)return stop();
 if(s.generation!==body.generation){s.sequence=body.nextSequence;s.previousValues=undefined;s.offlineSent=false;}
 // An unchanged generation keeps its local sequence: in-flight samples may precede this renewal.
 s.generation=body.generation;s.leaseExpiresAt=body.leaseExpiresAt;s.phase='active';s.lastRenew=now;s.nextRenew=now+Math.min(10000,Math.max(1000,Math.floor((body.leaseExpiresAt-now)/3)));s.nextAttempt=0;save();
 node.status({fill:'green',shape:'dot',text:'采集状态观察已就绪'});return null;
}
if(msg._tlePresenceTick===true){
 if(s.phase==='new'){
  if(typeof msg._msgid!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(msg._msgid))return stop();
  s.runNonce=msg._msgid;s.phase='challenge';
 }
 if(s.pending&&now-s.pending.started>=5000){s.pending=null;s.nextAttempt=now+5000;}
 let output=null;
 if(config.silenceTimeoutMs>0&&s.lastSample!==undefined&&now-s.lastSample>=config.silenceTimeoutMs&&s.unavailableSince===null)s.unavailableSince=now-config.failureWindowMs;
 if(s.unavailableSince!==null&&(!s.needsConsecutive||s.consecutiveFailures>=2)&&now-s.unavailableSince>=config.failureWindowMs&&(!s.offlineSent||now-s.lastOffline>=5000))output=envelope('status');
 let http=null;
 if(!s.pending&&now>=s.nextAttempt){
  if(s.phase==='challenge'||s.phase==='activate')http=request(s.phase);
  else if(s.phase==='active'&&now>=s.nextRenew)http=request('renew');
 }
 save();return output||http?[output,http]:null;
}
if(msg._tlePresenceSource===true){
 const observation=observe(msg);
 if(observation.ready||observation.reachable){s.acceptSample=true;s.unavailableSince=null;s.consecutiveFailures=0;s.offlineSent=false;save();return null;}
 if(observation.unavailable&&(!observation.requiresSample||s.lastSample!==undefined)){
  if(s.unavailableSince===null)s.unavailableSince=now;
  s.needsConsecutive=observation.consecutive===true;s.consecutiveFailures=(s.consecutiveFailures||0)+1;
  // Connection-oriented streams need a native connected event before accepting queued data.
  s.acceptSample=!['s7','tcp-client','tcp-server'].includes(config.protocol);
  if(observation.unavailable==='immediate')s.unavailableSince=now-config.failureWindowMs;
  save();
  if(observation.unavailable==='immediate'){
   const output=s.offlineSent&&now-s.lastOffline<5000?null:envelope('status');return output?[output,null]:null;
  }
 }
 return null;
}
if(msg.nodeId===config.nodeId&&config.serviceCodes.includes(msg.serviceId)&&s.acceptSample){
 const values=msg.payload;
 if(!values||typeof values!=='object'||Array.isArray(values)||!Object.keys(values).length)return null;
 const services=msg._tleServices;
 if(services!==undefined){
  if(!Array.isArray(services)||!services.length||services.length>config.serviceCodes.length)return null;
  const seen=new Set();let count=0;
  for(const group of services){
   if(!group||!config.serviceCodes.includes(group.serviceCode)||seen.has(group.serviceCode)||!group.values||typeof group.values!=='object'||Array.isArray(group.values))return null;
   const size=Object.keys(group.values).length;if(!size)return null;count+=size;seen.add(group.serviceCode);
  }
  if(count>config.maxPoints)return null;
 }
 const output=envelope('sample',values,services,msg.serviceId);
 if(output&&config.httpResponse&&msg.res){output.req=msg.req;output.res=msg.res;}
 return output?[output,null]:unavailable();
}
return null;`;

/** Native observation remains protocol-specific; state transport and runtime fencing are shared. */
export function presenceFlow(config: PresenceFlowConfig): FlowNode[] {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(config.nodeId)) {
    throw new TemplateError('ThingLinks 子设备标识需以字母、数字或下划线开头，且仅包含字母、数字、下划线、点、冒号或短横线');
  }
  if (!Number.isSafeInteger(config.failureWindowMs) || config.failureWindowMs < 1000) {
    throw new TemplateError('采集状态不可用判断窗口无效');
  }
  if (!Number.isSafeInteger(config.silenceTimeoutMs ?? 0) || (config.silenceTimeoutMs ?? 0) < 0) throw new TemplateError('静默超时无效');
  const serviceCodes = [...new Set((config.serviceCodes?.length ? config.serviceCodes : [config.serviceCode]).map(code => resolveServiceCode(code)))];
  if (serviceCodes.length > MAX_TEMPLATE_SERVICES) throw new TemplateError(`单个采集模板最多映射 ${MAX_TEMPLATE_SERVICES} 个服务`);
  const runtimeConfig = { nodeId: config.nodeId, serviceCode: serviceCodes[0]!, serviceCodes, maxPoints: MAX_TEMPLATE_POINTS, protocol: config.protocol, changesOnly: config.changesOnly === true, failureWindowMs: config.failureWindowMs, silenceTimeoutMs: config.silenceTimeoutMs ?? 0, httpResponse: config.httpResponse === true };
  const nodes: FlowNode[] = [
    { id: 'presence', type: 'function', z: 'tab', name: '采集状态与变化上报', func: `const config=${JSON.stringify(runtimeConfig)};\nconst observe=msg=>{${observationScript(config.protocol)}};\n${BODY}`, initialize: INITIALIZE, finalize: FINALIZE, outputs: config.httpResponse ? 3 : 2, timeout: 1, noerr: 0, libs: [], x: 650, y: 240, wires: config.httpResponse ? [['device'], ['presence-http'], ['response']] : [['device'], ['presence-http']] },
    { id: 'presence-tick', type: 'inject', z: 'tab', name: '维护采集状态观察', props: [{ p: '_tlePresenceTick', v: 'true', vt: 'bool' }], repeat: '1', crontab: '', once: true, onceDelay: 0.1, x: 160, y: 460, wires: [['presence']] },
    { id: 'presence-status', type: 'status', z: 'tab', name: '现场协议连接状态', scope: config.sourceIds, x: 160, y: 540, wires: [['presence-source']] },
    { id: 'presence-errors', type: 'catch', z: 'tab', name: '现场协议连接异常', scope: config.sourceIds, uncaught: false, x: 160, y: 600, wires: [['presence-source']] },
    { id: 'presence-source', type: 'change', z: 'tab', name: '标记原生协议观察', rules: [{ t: 'set', p: '_tlePresenceSource', pt: 'msg', to: 'true', tot: 'bool' }], x: 400, y: 540, wires: [['presence']] },
    { id: 'presence-http', type: 'http request', z: 'tab', name: '登记与续租采集观察', method: 'use', ret: 'obj', paytoqs: 'ignore', url: '', tls: '', persist: false, proxy: '', insecureHTTPParser: false, authType: '', senderr: false, headers: [], x: 900, y: 460, wires: [['presence']] },
    { id: 'presence-http-errors', type: 'catch', z: 'tab', name: '采集观察服务暂不可达', scope: ['presence-http'], uncaught: false, x: 650, y: 600, wires: [['presence']] },
  ];
  return config.sourceIds.length ? nodes : nodes.filter(node => !['presence-status','presence-errors'].includes(node.id));
}
