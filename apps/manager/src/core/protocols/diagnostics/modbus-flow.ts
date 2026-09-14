import { createHash } from 'node:crypto';
import type { SingleFlowConfig } from '../../flows/admin-client.ts';
import type { FlowNode } from '../../flows/types.ts';
import { host as validateHost } from '../../flows/templates/builtin/common.ts';

export interface ModbusDiagnosticFlowInput {
  taskId: string;
  readerId: string;
  host: string;
  port: number;
  unitId: number;
  registerType: 'HoldingRegister' | 'InputRegister';
  address: number;
  quantity: number;
  clientTimeout: number;
  reconnectTimeout: number;
  expiresAt: number;
}

/** Fixed controller program. Only serialized configuration enters it; no credentials live in the flow JSON. */
function controllerScript(config: ModbusDiagnosticFlowInput): string {
  return `const config=${JSON.stringify(config)};
const now=Date.now(),key='__tle_diagnostic_'+config.taskId;
let state=flow.get(key)||{phase:'waiting',ready:false,claimAttempts:0,claimFailures:0,resultAttempts:0};
const save=()=>flow.set(key,state);
if(now>=config.expiresAt){state.phase='expired';save();return null;}
if(state.phase==='done'||state.phase==='expired')return null;
const marker=msg._tleDiagnostic;
const matched=marker&&marker.taskId===config.taskId&&marker.readerId===config.readerId;
const request=(kind,payload,attempt)=>{
 const base=env.get('TLE_MANAGER_URL'),token=env.get('TLE_INGEST_TOKEN');
 if(typeof base!=='string'||!base||typeof token!=='string'||!token){state.phase='done';save();return null;}
 return {method:'POST',url:base.replace(/\\/$/,'')+'/api/edge/protocol-diagnostics/'+encodeURIComponent(config.taskId)+'/'+kind,
  headers:{'content-type':'application/json',authorization:'Bearer '+token},payload,requestTimeout:2000,
  _tleDiagnostic:{taskId:config.taskId,readerId:config.readerId,kind,attempt}};
};
const report=(body)=>{
 state.phase='reporting';
 state.result={readerId:config.readerId,leaseToken:state.leaseToken,durationMs:Math.max(1,now-(state.startedAt||now)),...body};
 state.resultAttempts=1;state.resultAt=now;save();
 return [null,null,request('result',state.result,state.resultAttempts)];
};
if(msg.status&&msg.status.source&&msg.status.source.id===config.readerId){
 state.ready=msg.status.text==='active'&&msg.status.fill==='green'&&msg.status.shape==='dot';
 // A read timeout also causes failure/closed/reconnecting statuses in the native driver.
 // Status proves readiness only. Preserve the actual request error, or wait for the read deadline.
 save();
}
if(matched&&marker.kind==='result'){
 if(state.phase!=='reporting'||marker.attempt!==state.resultAttempts)return null;
 if(!msg.error&&((msg.statusCode>=200&&msg.statusCode<300)||msg.statusCode===404||msg.statusCode===409)){state.phase='done';save();}
 return null;
}
if(matched&&marker.kind==='claim'){
 if(state.phase!=='claiming'||marker.attempt!==state.claimAttempts)return null;
 if(msg.error||msg.statusCode<200||msg.statusCode>=300){
  if(msg.statusCode===404||msg.statusCode===409||msg.statusCode===401||msg.statusCode===403){state.phase='done';}
  else{
   state.phase='waiting';
   // Node-RED may have started this tab before Manager finishes verifying its Admin API readback.
   // A 503 is a readiness wait, bounded by the task deadline. Other transport failures are capped.
   if(msg.statusCode!==503||msg.error)state.claimFailures++;
   state.nextClaimAt=now+(msg.statusCode===503&&!msg.error?1000:500);
  }
  save();return null;
 }
 const lease=msg.payload;
 if(!lease||typeof lease.leaseToken!=='string'||!/^[-_a-zA-Z0-9]{32,128}$/.test(lease.leaseToken)||
  !Number.isSafeInteger(lease.deadline)||lease.deadline>config.expiresAt||lease.deadline<=now){state.phase='done';save();return null;}
 state.leaseToken=lease.leaseToken;state.leaseDeadline=lease.deadline;state.startedAt=now;
 if(!state.ready)return report({errorCode:'CONNECT_FAILED'});
 if(now+config.clientTimeout+50>lease.deadline)return report({errorCode:'READ_TIMEOUT'});
 state.phase='reading';state.readDeadline=now+config.clientTimeout+50;save();
 return [null,{payload:{},_tleDiagnostic:{taskId:config.taskId,readerId:config.readerId,kind:'read',leaseToken:state.leaseToken}},null];
}
if(matched&&marker.kind==='read'){
 if(state.phase!=='reading'||marker.leaseToken!==state.leaseToken)return null;
 if(now>=state.readDeadline||now>=state.leaseDeadline)return report({errorCode:'READ_TIMEOUT'});
 if(msg.error){
  if(!msg.error.source||msg.error.source.id!==config.readerId)return null;
  const error=typeof msg.error.message==='string'?msg.error.message.slice(0,1024):'';
  const code=/timeout|timed out/i.test(error)?'READ_TIMEOUT':/ECONN|EHOST|connection.*(?:closed|refused|failed)/i.test(error)?'CONNECT_FAILED':'READ_FAILED';
  return report({errorCode:code});
 }
 if(!Array.isArray(msg.payload)||msg.payload.length!==config.quantity||msg.payload.some(v=>!Number.isInteger(v)||v<0||v>65535)){
  return report({errorCode:'INVALID_RESPONSE'});
 }
 return report({registers:msg.payload.slice()});
}
if(msg._tleDiagnosticTick!==true&&!msg.status)return null;
if(state.phase==='reading'&&now>=state.readDeadline)return report({errorCode:'READ_TIMEOUT'});
if(state.phase==='reporting'){
 if(state.resultAttempts>=5||now>=state.leaseDeadline){state.phase='done';save();return null;}
 if(now-state.resultAt<2500)return null;
 state.resultAt=now;state.resultAttempts++;save();
 return [null,null,request('result',state.result,state.resultAttempts)];
}
if(state.phase==='claiming'){
 if(now-state.claimAt<2500)return null;
 state.phase='waiting';state.claimFailures++;
}
if(state.phase!=='waiting'||!state.ready||now<(state.nextClaimAt||0))return null;
if(state.claimFailures>=5||now+config.clientTimeout+50>=config.expiresAt){state.phase='done';save();return null;}
state.phase='claiming';state.claimAt=now;state.claimAttempts++;save();
return [request('claim',{readerId:config.readerId},state.claimAttempts),null,null];`;
}

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}不在允许的整数范围内`);
}

export function buildModbusDiagnosticFlow(input: ModbusDiagnosticFlowInput): {
  flow: SingleFlowConfig & { id: string };
  nodeIds: string[];
  fingerprint: string;
} {
  const config = { ...input, host: validateHost(input.host) };
  for (const id of [config.taskId, config.readerId]) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('试读任务或读取节点标识无效');
  }
  integer(config.port, 1, 65535, '设备端口'); integer(config.unitId, 0, 255, '单元标识 Unit ID');
  integer(config.address, 0, 65535, '起始地址'); integer(config.quantity, 1, 125, '读取数量');
  integer(config.clientTimeout, 100, 60000, '读取超时'); integer(config.reconnectTimeout, 100, 60000, '重连间隔');
  integer(config.expiresAt, 1, 8_640_000_000_000_000, '截止时间');
  if (config.address + config.quantity > 65536 || !['HoldingRegister', 'InputRegister'].includes(config.registerType)) {
    throw new Error('试读只允许有效范围内的 FC3/FC4 寄存器读取');
  }
  const id = `tld-${config.taskId}`, nodeId = (role: string) => `${id}-${role}`;
  const controller = nodeId('control'), client = nodeId('client'), claim = nodeId('claim'), result = nodeId('result');
  const httpNode = (node: string, name: string, x: number): FlowNode => ({
    id: node, z: id, type: 'http request', name, method: 'use', ret: 'obj', paytoqs: 'ignore', url: '', tls: '',
    persist: false, proxy: '', authType: '', senderr: true, headers: [], x, y: 240, wires: [[controller]],
  });
  const flow: SingleFlowConfig & { id: string } = {
    id, label: 'Modbus 临时单次试读', disabled: false,
    info: `ThingLinks diagnostic ${config.taskId}. 截止后不再请求租约或发起读取；连接节点仍可能重连，须由 Manager 删除此临时页。`,
    env: [],
    nodes: [
      { id: nodeId('tick'), z: id, type: 'inject', name: '等待连接与检查截止时间', props: [{ p: '_tleDiagnosticTick', v: 'true', vt: 'bool' }],
        repeat: '0.25', crontab: '', once: true, onceDelay: 0.1, x: 160, y: 100, wires: [[controller]] },
      { id: nodeId('status'), z: id, type: 'status', name: '等待读取节点 active', scope: [config.readerId], x: 160, y: 160, wires: [[controller]] },
      { id: controller, z: id, type: 'function', name: '一次租约与受限试读', func: controllerScript(config), outputs: 3, timeout: 1,
        noerr: 0, initialize: '', finalize: '', libs: [], x: 450, y: 150, wires: [[claim], [config.readerId], [result]] },
      httpNode(claim, '申请单次试读租约', 180),
      { id: config.readerId, z: id, type: 'modbus-getter', name: '只读一次寄存器', unitid: String(config.unitId),
        dataType: config.registerType, adr: String(config.address), quantity: String(config.quantity), server: client,
        showStatusActivities: true, showErrors: true, showWarnings: true, logIOActivities: false,
        useIOFile: false, ioFile: '', useIOForPayload: false, emptyMsgOnFail: false,
        keepMsgProperties: true, msgThruput: false, delayOnStart: false, enableDeformedMessages: false,
        x: 740, y: 140, wires: [[controller], []] },
      httpNode(result, '回报单次试读结果', 740),
      { id: nodeId('errors'), z: id, type: 'catch', name: '试读失败与回报失败', scope: [claim, result, config.readerId],
        uncaught: false, x: 450, y: 330, wires: [[controller]] },
    ],
    configs: [{ id: client, z: id, type: 'modbus-client', name: '临时试读专用连接', clienttype: 'tcp',
      bufferCommands: false, stateLogEnabled: false, queueLogEnabled: false, failureLogEnabled: false,
      tcpHost: config.host, tcpPort: config.port, tcpType: 'DEFAULT', unit_id: config.unitId,
      commandDelay: 1, clientTimeout: config.clientTimeout, reconnectOnTimeout: true,
      reconnectTimeout: config.reconnectTimeout, parallelUnitIdsAllowed: false,
    }],
  };
  return { flow, nodeIds: [...flow.nodes, ...flow.configs!].map(node => node.id), fingerprint: modbusDiagnosticFingerprint(flow) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** Only tab rebinding, array order and verified internal _users metadata may differ after Node-RED reads it back. */
export function modbusDiagnosticFingerprint(flow: SingleFlowConfig): string {
  if (typeof flow.id !== 'string' || !Array.isArray(flow.nodes) || !Array.isArray(flow.configs)) throw new Error('试读流程结构无效');
  const ids = new Set([...flow.nodes, ...flow.configs].map(node => node.id));
  if (ids.size !== flow.nodes.length + flow.configs.length) throw new Error('试读流程节点标识重复');
  const normalize = (nodes: FlowNode[]) => nodes.map(node => {
    if (node.z !== flow.id) throw new Error('试读节点不属于该流程');
    if (node._users !== undefined && (!Array.isArray(node._users) || node._users.some(user => !ids.has(String(user))))) {
      throw new Error('试读连接被其他流程引用，不能自动清理');
    }
    const { z: _z, _users, ...rest } = node;
    return rest;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const { id: _id, nodes, configs, ...metadata } = flow;
  return createHash('sha256').update(JSON.stringify(canonical({ ...metadata, nodes: normalize(nodes), configs: normalize(configs!) }))).digest('hex');
}
