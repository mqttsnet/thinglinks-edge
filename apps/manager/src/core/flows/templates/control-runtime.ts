/** Fixed HTTP bridge scripts; credentials are resolved inside the instance and never saved in recipes. */
export interface ControlBindingConfig {
  nodeId: string;
  serviceCode: string;
  commands: { cmd: string; param: string; property: string }[];
}
const REQUEST = `
const base=env.get('TLE_MANAGER_URL'),token=env.get('TLE_INGEST_TOKEN');
if(!base||!token){node.error('实例未配置 ThingLinks 命令桥接入信息',msg);return null;}
msg.method='POST';msg.headers={'content-type':'application/json',authorization:'Bearer '+token};msg.requestTimeout=5000;
`;
const pendingKey = '__tle_control_pending';
const resultKey = '__tle_control_result';
const pollKey = '__tle_control_poll_until';

export function bindingPollScript(config: ControlBindingConfig): string {
  const binding = {
    nodeId: config.nodeId,
    serviceCode: config.serviceCode,
    commands: config.commands.map(({ cmd, param }) => ({ cmd, param })),
  };
  return `${REQUEST}
const now=Date.now();
if((flow.get('${pollKey}')||0)>now)return null;
flow.set('${pollKey}',now+12000);
const result=flow.get('${resultKey}');
if(result){
 if(now-result.time>60000){flow.set('${resultKey}',undefined);flow.set('${pendingKey}',undefined);node.error('执行结果未能及时提交，请查看 Edge 命令记录',msg);}
 else {msg.url=base+'/api/edge/commands/'+encodeURIComponent(result.id)+'/result';msg.payload=result.body;msg._tleResultId=result.id;return [null,msg,null];}
}
const pending=flow.get('${pendingKey}');
if(pending&&now-pending.time<32000){flow.set('${pollKey}',0);return null;}
if(pending){flow.set('${pendingKey}',undefined);node.send([null,null,{reset:true}]);}
msg._tleConsumer=node.id;msg.url=base+'/api/edge/command-bindings';msg.payload={...${JSON.stringify(binding)},consumerId:node.id};
return [msg,null,null];`;
}

export function nextCommandScript(config: ControlBindingConfig): string {
  return `if(msg.statusCode<200||msg.statusCode>=300){flow.set('${pollKey}',0);node.error('命令绑定未成功，请检查重复设备映射或实例权限',msg);return null;}
${REQUEST}
msg.url=base+'/api/edge/commands/next';msg.payload={consumerId:msg._tleConsumer,nodeId:${JSON.stringify(config.nodeId)},serviceCode:${JSON.stringify(config.serviceCode)}};return msg;`;
}

export function claimCommandScript(): string {
  return `flow.set('${pollKey}',0);
if(msg.statusCode<200||msg.statusCode>=300){node.error('命令获取失败',msg);return null;}
const command=msg.payload&&msg.payload.command;
if(!command)return null;
if(typeof command.id!=='string'||typeof command.leaseToken!=='string'){node.error('命令租约无效',msg);return null;}
if(!Number.isSafeInteger(command.leaseDeadline)||command.leaseDeadline<=Date.now()){node.error('命令租约截止时间无效或已过期，本条不执行',msg);return null;}
const pending=flow.get('${pendingKey}');
if(pending){node.error('设备已有执行中的命令，本条不重复执行',msg);return null;}
flow.set('${pendingKey}',{command,time:Date.now()});msg._tleCommand=command;return msg;`;
}

export function commandResultScript(protocol: string, success: boolean, ackField = 'ok'): string {
  return `const command=msg._tleCommand||(msg.input&&msg.input._tleCommand);
if(!command||typeof command.id!=='string'||typeof command.leaseToken!=='string')return null;
const pending=flow.get('${pendingKey}');
if(!pending||pending.command.id!==command.id||pending.command.leaseToken!==command.leaseToken)return null;
let ok=${success},reason='',unknown=false;
// Driver errors can be structured objects containing request/credential material. Never copy them into Cloud receipts.
const rawDetail=msg.error&&msg.error.message;
let detail='协议节点报告错误，详情请在实例日志中核对';
if(typeof rawDetail==='string'){
 const text=rawDetail.slice(0,1024);
 if(/timeout|timed out|超时/i.test(text))detail='等待设备确认超时';
 else if(/ECONN|EHOST|BadConnection|connection.*(?:closed|failed|refused)|连接/i.test(text))detail='设备连接中断或不可用';
 else if(msg._tleExplicitRejection===true)detail='协议节点明确拒绝本次请求';
}
if(!ok)reason='设备执行失败：'+detail;
if(!ok && msg._tleWriteAttempted===true && msg._tleExplicitRejection!==true){unknown=true;reason='设备执行结果未知：'+detail;}
if(ok&&${JSON.stringify(protocol)}==='opcua'){
 const status=msg.payload,code=typeof status==='number'?status:status&&status.value;
 if(!Number.isInteger(code)||code<0||code>0xffffffff||(code>>>30)!==0){ok=false;reason='OPC UA 写入未返回 Good 状态';}
}
if(ok&&${JSON.stringify(protocol)}==='http'){
 if(msg.statusCode!==200||!msg.payload||msg.payload[${JSON.stringify(ackField)}]!==true){ok=false;unknown=msg.statusCode===202||!msg.payload||msg.payload[${JSON.stringify(ackField)}]!==false;reason='HTTP 控制接口未明确确认执行成功';}
}
${REQUEST}
const body={leaseToken:command.leaseToken,ok,result:ok?{...pending.command.params}:{},...(!ok?{error:reason}:{}),...(unknown?{unknown:true}:{})};
flow.set('${resultKey}',{id:command.id,body,time:Date.now()});flow.set('${pendingKey}',undefined);flow.set('${pollKey}',Date.now()+6000);
msg.url=base+'/api/edge/commands/'+encodeURIComponent(command.id)+'/result';msg.payload=body;msg._tleResultId=command.id;return msg;`;
}

/** Network devices explicitly acknowledge a unique requestId; delivery alone is never success. */
export function networkAckScript(protocol: 'tcp' | 'udp', ackField = 'ok'): string {
  return `const succeed=function(msg){${commandResultScript(protocol, true)}};
const fail=function(msg){${commandResultScript(protocol, false)}};
const pending=flow.get('${pendingKey}');if(!pending)return null;
try{
 const body=Buffer.isBuffer(msg.payload)?JSON.parse(msg.payload.toString('utf8')):typeof msg.payload==='string'?JSON.parse(msg.payload):msg.payload;
 if(!body||body.requestId!==pending.command.id)return null;
 msg._tleCommand=pending.command;
 if(body[${JSON.stringify(ackField)}]!==true){msg._tleExplicitRejection=body[${JSON.stringify(ackField)}]===false;msg._tleWriteAttempted=true;msg.error={message:'设备未确认执行成功'};return fail(msg);}
 return succeed(msg);
}catch(error){node.error('设备命令应答格式无效',msg);return null;}`;
}

export function resultDeliveredScript(): string {
  return `flow.set('${pollKey}',0);
const saved=flow.get('${resultKey}');
if(!saved||saved.id!==msg._tleResultId)return null;
if(msg.statusCode>=200&&msg.statusCode<300){flow.set('${resultKey}',undefined);}
else if(msg.statusCode===409||msg.statusCode===404){flow.set('${resultKey}',undefined);node.error('命令租约已失效，执行结果请在 Edge 记录中核对',msg);}
else node.error('执行结果提交失败，将重试回执且不重新执行设备命令',msg);
return null;`;
}
