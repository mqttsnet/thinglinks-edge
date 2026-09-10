import type { FlowNode } from '../types.ts';
import { functionNode } from './builtin/common.ts';

/** Pure message shaping around an existing Node-RED component; no protocol or TLS implementation. */
export function managedOpcuaControlNodes(connectionId: string, points: Record<string, unknown>[], timeoutMs: number): FlowNode[] {
  const allowed = points.map(point => ({ nodeId: String(point.source), dataType: String(point.dataType) }));
  const prepare = `msg._tleWriteAttempted=false;
try {
 const deadline=msg._tleCommand&&msg._tleCommand.leaseDeadline;
 const budget=${Math.max(1000, timeoutMs) * 2 + 1000};
 if(!Number.isSafeInteger(deadline)||deadline-Date.now()<budget)throw new Error('命令租约剩余时间不足，尚未交给 OPC UA 写入节点');
 const allowed=${JSON.stringify(allowed)};
 const target=allowed.find(point=>msg.topic===point.nodeId+';datatype='+point.dataType);
 if(!target)throw new Error('OPC UA 控制目标不在配置映射中');
 const value=msg.payload;
 // A String value that looks like JSON must not become the component's dynamic point list.
 for(const key of ['nodeId','dataType','topic','items','indexRange','range','opcuaDeadline'])delete msg[key];
 msg.payload=[{nodeId:target.nodeId,dataType:target.dataType,value}];msg.opcua={pointList:true};
 msg._tleOpcuaTarget=target.nodeId;msg._tleWriteAttempted=true;msg._tleExplicitRejection=false;
 return msg;
}catch(error){node.error(error.message,msg);return null;}`;
  const result = `msg._tleWriteAttempted=true;msg._tleExplicitRejection=false;
const expected=msg._tleOpcuaTarget;
const allowed=${JSON.stringify(allowed.map(point => point.nodeId))};
const rows=msg.payload,meta=msg.opcua;
if(typeof expected==='string'&&allowed.includes(expected)&&Array.isArray(rows)&&rows.length===1&&rows[0]?.nodeId===expected&&meta?.operation==='write'&&meta.total===1){
 const status=rows[0].statusCode;
 if(status==='Good'&&meta.good===1){msg.payload={value:0};delete msg.error;return [msg,null];}
 const rejected=['BadNotWritable','BadTypeMismatch','BadUserAccessDenied','BadNodeIdUnknown','BadOutOfRange','BadNotSupported','BadAttributeIdInvalid'];
 if(meta.good===0&&rejected.includes(status)){msg._tleExplicitRejection=true;msg.error={message:'OPC UA 服务器拒绝写入：'+status};return [null,msg];}
}
msg.error={message:'OPC UA 写入未取得目标点位明确 Good 确认'};return [null,msg];`;
  const error = `const message=String(msg.error&&msg.error.message||'').replace(/^Error:\\s*/, '');
msg._tleExplicitRejection=false;
if(message==='OPC UA client command queue is full'||message==='OPC UA client command timed out while queued'){
 msg._tleWriteAttempted=false;msg._tleExplicitRejection=true;
}
return msg;`;
  return [
    functionNode('control-opcua-prepare', '检查租约预算与单点写入', prepare, [['control-writer']]),
    { id: 'control-writer', type: 'tier0-opcua-write', z: 'tab', name: 'OPC UA 写入', connection: connectionId,
      nodeId: '', dataType: 'Double', batchSize: 1, outputMode: 'batch', x: 740, y: 550, wires: [['control-opcua-result']] },
    functionNode('control-opcua-result', '核对目标与写入质量', result, [['control-result'], ['control-failed']]),
    functionNode('control-opcua-error', '区分排队拒绝与未知结果', error, [['control-failed']]),
  ];
}
