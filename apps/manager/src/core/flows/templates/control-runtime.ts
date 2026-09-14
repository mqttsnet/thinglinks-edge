import { TemplateError } from '../types.ts';
import type { ControlMapping } from './control-mapping.ts';
import { MAX_TEMPLATE_SERVICES, resolveServiceCode } from './service-mapping.ts';

export interface ControlBindingConfig {
  nodeId: string;
  serviceCode: string;
  commands: ControlMapping[];
}

/** Each generated controller owns one VM; leases never enter configured persistent context stores. */
export const CONTROL_INITIALIZE = "globalThis.__tleControl={run:String(Date.now())+':'+Math.random().toString(16).slice(2),sequence:0,cursor:0,registered:false,nextHeartbeat:0,nextPoll:0,binding:null,poll:null,pending:null,result:null};";
export const CONTROL_FINALIZE = 'delete globalThis.__tleControl;';

/** Outputs: binding heartbeat, next command, encoding, receipt, TCP reset, guarded physical execution. */
export function controlControllerScript(config: ControlBindingConfig, protocol = ''): string {
  const services: { serviceCode: string; commands: { cmd: string; param: string }[] }[] = [];
  if (!config.commands.length || config.commands.length > 64) throw new TemplateError('命令映射需要 1–64 项');
  for (const mapping of config.commands) {
    const serviceCode = resolveServiceCode(mapping.serviceCode, config.serviceCode);
    let service = services.find(item => item.serviceCode === serviceCode);
    if (!service) { service = { serviceCode, commands: [] }; services.push(service); }
    service.commands.push({ cmd: mapping.cmd, param: mapping.param });
  }
  if (services.length > MAX_TEMPLATE_SERVICES) throw new TemplateError(`控制映射最多包含 ${MAX_TEMPLATE_SERVICES} 个服务`);
  return `const config=${JSON.stringify({ nodeId: config.nodeId, services })};
const state=globalThis.__tleControl;if(!state)return null;
const now=Date.now(),out=[null,null,null,null,null,null];
const finish=()=>out.some(Boolean)?out:null;
const request=(kind,path,payload)=>{
 const base=env.get('TLE_MANAGER_URL'),token=env.get('TLE_INGEST_TOKEN');
 if(typeof base!=='string'||!base||typeof token!=='string'||!token){node.error('实例未配置 ThingLinks 命令桥接入信息');return null;}
 return {method:'POST',url:base.replace(/\\/$/,'')+path,headers:{'content-type':'application/json',authorization:'Bearer '+token},
  requestTimeout:5000,payload,_tleControl:{run:state.run,kind,sequence:++state.sequence}};
};
const sendReceipt=()=>{
 const result=state.result;
 const message=request('receipt','/api/edge/commands/'+encodeURIComponent(result.id)+'/result',result.body);
 if(message){result.transport={sequence:message._tleControl.sequence,deadline:now+5500};result.retryAt=now+2500;out[3]=message;}
};
const recordResult=(value)=>{
 const pending=state.pending;if(!pending)return;
 const command=pending.command;
 state.pending=null;
 state.result={id:command.id,body:{leaseToken:command.leaseToken,ok:value.ok,result:value.ok?{...command.params}:{},
  ...(value.unknown?{unknown:true}:{}),...(!value.ok?{error:value.error||'设备未明确确认执行成功'}:{})},until:now+60000,retryAt:now,transport:null};
 sendReceipt();
};
if(state.pending&&now>=state.pending.command.leaseDeadline){
 const attempted=state.pending.phase==='executing';
 recordResult({ok:false,unknown:attempted,error:attempted?'执行租约超时，设备执行结果未知，禁止自动重试':'命令租约过期，尚未提交设备写入'});out[4]={reset:true};
}
const marker=msg._tleControl;
if(marker&&(marker.run!==state.run||!Number.isSafeInteger(marker.sequence)))return finish();
if(marker&&marker.kind==='binding'){
 if(!state.binding||marker.sequence!==state.binding.sequence)return finish();
 state.binding=null;
 state.registered=!msg.error&&msg.statusCode>=200&&msg.statusCode<300&&msg.payload&&msg.payload.accepted===${config.commands.length};
 if(!state.registered){state.nextHeartbeat=now+2000;node.error('命令绑定未完整登记，请检查映射与实例权限');}
 return finish();
}
if(marker&&marker.kind==='poll'){
 const poll=state.poll;
 if(!poll||marker.sequence!==poll.sequence||now>=poll.deadline)return finish();
 state.poll=null;
 if(msg.error||!Number.isInteger(msg.statusCode)||msg.statusCode<200||msg.statusCode>=300){node.error('命令获取失败');return finish();}
 const command=msg.payload&&msg.payload.command;
 if(!command)return finish();
 const service=config.services.find(item=>item.serviceCode===poll.serviceCode);
 const keys=command.params&&typeof command.params==='object'&&!Array.isArray(command.params)?Object.keys(command.params):[];
 const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
 if(!identifier(command.id)||!identifier(command.leaseToken)||
  command.deviceIdentification!==config.nodeId||command.serviceCode!==poll.serviceCode||keys.length!==1||
  !service.commands.some(item=>item.cmd===command.cmd&&item.param===keys[0])||
  !Number.isSafeInteger(command.leaseDeadline)||command.leaseDeadline<=now){node.error('命令身份、映射或绝对租约无效，本条不执行');return finish();}
 if(state.pending||state.result){node.error('设备已有执行或待提交结果，本条不重复执行');return finish();}
 state.pending={command,sequence:marker.sequence,phase:'encoding'};
 out[2]={payload:{command},_tleCommand:command,_tleControl:{run:state.run,sequence:marker.sequence,kind:'execution'}};
 return finish();
}
if(marker&&marker.kind==='receipt'){
 const result=state.result;
 if(!result||!result.transport||marker.sequence!==result.transport.sequence)return finish();
 result.transport=null;
 if(!msg.error&&msg.statusCode>=200&&msg.statusCode<300){state.result=null;}
 else if(msg.statusCode===404||msg.statusCode===409){state.result=null;node.error('命令租约已失效，执行结果请在 Edge 记录中核对');}
 else {result.retryAt=now+2500;node.error('执行结果提交失败，将重试回执且不重新写设备');}
 return finish();
}
if(msg._tlePrepared===true){
 const pending=state.pending;
 if(!pending||pending.phase!=='encoding'||!marker||marker.kind!=='execution'||marker.sequence!==pending.sequence||
  msg._tleCommand?.id!==pending.command.id||msg._tleCommand?.leaseToken!==pending.command.leaseToken)return finish();
 pending.phase='executing';delete msg._tlePrepared;msg._tleWriteAttempted=${protocol !== 'opcua'};out[5]=msg;return finish();
}
if(msg._tleExecutionResult){
 const value=msg._tleExecutionResult,pending=state.pending;
 if(!pending||!marker||marker.kind!=='execution'||marker.sequence!==pending.sequence||
  value.id!==pending.command.id||value.leaseToken!==pending.command.leaseToken||typeof value.ok!=='boolean'||
  (value.unknown!==undefined&&typeof value.unknown!=='boolean')||(value.ok&&value.unknown)||(value.ok&&pending.phase!=='executing'))return finish();
 recordResult(value);return finish();
}
if(msg._tleNetworkAck){
 const ack=msg._tleNetworkAck,pending=state.pending;
 if(!pending||pending.phase!=='executing'||ack.id!==pending.command.id||(marker&&(marker.kind!=='execution'||marker.sequence!==pending.sequence)))return finish();
 recordResult({ok:ack.ok===true,unknown:ack.ok!==true&&ack.ok!==false,error:'设备未明确确认执行成功'});return finish();
}
if(msg._tleControlTick!==true)return finish();
if(state.binding&&now>=state.binding.deadline){state.binding=null;state.registered=false;state.nextHeartbeat=now;}
if(!state.binding&&now>=state.nextHeartbeat){
 const message=request('binding','/api/edge/command-bindings',{consumerId:node.id,...config});
 if(message){state.binding={sequence:message._tleControl.sequence,deadline:now+5500};state.nextHeartbeat=now+10000;out[0]=message;}
}
if(state.result){
 const result=state.result;
 if(now>=result.until){state.result=null;node.error('执行结果未能及时提交，请查看 Edge 命令记录');}
 else {
  if(result.transport&&now>=result.transport.deadline)result.transport=null;
  if(!result.transport&&now>=result.retryAt)sendReceipt();
  return finish();
 }
}
if(state.pending)return finish();
if(state.poll){if(now<state.poll.deadline)return finish();state.poll=null;state.nextPoll=now+1000;}
if(state.registered&&now>=state.nextPoll){
 const service=config.services[state.cursor];state.cursor=(state.cursor+1)%config.services.length;
 const message=request('poll','/api/edge/commands/next',{consumerId:node.id,nodeId:config.nodeId,serviceCode:service.serviceCode});
 if(message){state.poll={sequence:message._tleControl.sequence,serviceCode:service.serviceCode,deadline:now+5500};state.nextPoll=now+1000;out[1]=message;}
}
return finish();`;
}

/** Pure protocol result classification. The controller alone owns pending state and receipt retries. */
export function commandResultScript(protocol: string, success: boolean, ackField = 'ok'): string {
  return `const command=msg._tleCommand||(msg.input&&msg.input._tleCommand);
if(!command||typeof command.id!=='string'||typeof command.leaseToken!=='string')return null;
if(!msg._tleControl&&msg.input)msg._tleControl=msg.input._tleControl;
let ok=${success},reason='',unknown=false;
const rawDetail=msg.error&&msg.error.message;
let detail='协议节点报告错误，详情请在实例日志中核对';
if(typeof rawDetail==='string'){
 const text=rawDetail.slice(0,1024);
 if(/timeout|timed out|超时/i.test(text))detail='等待设备确认超时';
 else if(/ECONN|EHOST|BadConnection|connection.*(?:closed|failed|refused)|连接/i.test(text))detail='设备连接中断或不可用';
 else if(msg._tleExplicitRejection===true)detail='协议节点明确拒绝本次请求';
}
if(!ok)reason='设备执行失败：'+detail;
if(!ok&&msg._tleWriteAttempted===true&&msg._tleExplicitRejection!==true){unknown=true;reason='设备执行结果未知：'+detail;}
if(ok&&${JSON.stringify(protocol)}==='opcua'){
 const status=msg.payload,code=typeof status==='number'?status:status&&status.value;
 if(!Number.isInteger(code)||code<0||code>0xffffffff||(code>>>30)!==0){ok=false;reason='OPC UA 写入未返回 Good 状态';}
}
if(ok&&${JSON.stringify(protocol)}==='http'){
 if(msg.statusCode!==200||!msg.payload||msg.payload[${JSON.stringify(ackField)}]!==true){ok=false;unknown=msg.statusCode===202||!msg.payload||msg.payload[${JSON.stringify(ackField)}]!==false;reason='HTTP 控制接口未明确确认执行成功';}
}
msg._tleExecutionResult={id:command.id,leaseToken:command.leaseToken,ok,...(!ok?{error:reason}:{}),...(unknown?{unknown:true}:{})};
return msg;`;
}

/** An unsolicited UDP packet only supplies an id/ack; the VM controller supplies its current lease. */
export function networkAckScript(_protocol: 'tcp' | 'udp', ackField = 'ok'): string {
  return `try{
 const body=Buffer.isBuffer(msg.payload)?JSON.parse(msg.payload.toString('utf8')):typeof msg.payload==='string'?JSON.parse(msg.payload):msg.payload;
 if(!body||typeof body.requestId!=='string')return null;
 msg._tleNetworkAck={id:body.requestId,ok:body[${JSON.stringify(ackField)}]};return msg;
}catch(error){node.error('设备命令应答格式无效');return null;}`;
}
