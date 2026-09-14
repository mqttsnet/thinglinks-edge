import { TemplateError } from '../types.ts';
import { modbusReadPlan, MODBUS_RESPONSE_GRACE_MS } from './modbus-read-plan.ts';

export interface ModbusRoundConfig {
  address: number;
  quantity: number;
  unitId: number;
  fc: 3 | 4;
  clientTimeout: number;
}

/**
 * Shared pure round state machine for continuous collection and leased diagnostics.
 * The caller owns storage, timers and reporting. This only coordinates the native driver.
 * Every result is fenced by its round and chunk; only complete rounds have `complete`.
 */
export function modbusRoundProgram(config: ModbusRoundConfig): string {
  const plan = modbusReadPlan(config.address, config.quantity);
  if (!Number.isSafeInteger(config.unitId) || config.unitId < 0 || config.unitId > 255 || ![3, 4].includes(config.fc)
    || !Number.isSafeInteger(config.clientTimeout) || config.clientTimeout < 100 || config.clientTimeout > 60000) {
    throw new TemplateError('Modbus 读取功能码、单元标识或超时无效');
  }
  return `const modbusConfig=${JSON.stringify({ ...config, plan })};
const advanceModbusRound=(state,event,now)=>{
 const unchanged=()=>({state});
 const failed=failure=>({state:null,failure});
 const next=()=>{
  const chunk=modbusConfig.plan[state.index];
  state.deadline=Math.min(state.totalDeadline,now+modbusConfig.clientTimeout+${MODBUS_RESPONSE_GRACE_MS});
  if(state.deadline<=now)return failed('READ_TIMEOUT');
  return {state,request:{payload:{fc:modbusConfig.fc,unitid:modbusConfig.unitId,address:chunk.address,quantity:chunk.quantity},
   _tleModbusCycle:{nonce:state.nonce,index:state.index}}};
 };
 if(event.kind==='start'){
  if(state)return unchanged();
  if(typeof event.nonce!=='string'||!event.nonce)return failed('INVALID_RESPONSE');
  const budget=modbusConfig.plan.length*(modbusConfig.clientTimeout+${MODBUS_RESPONSE_GRACE_MS});
  const totalDeadline=event.deadline===undefined?now+budget:Math.min(event.deadline,now+budget);
  if(!Number.isSafeInteger(totalDeadline)||totalDeadline<=now)return failed('READ_TIMEOUT');
  state={nonce:event.nonce,index:0,values:[],totalDeadline,deadline:totalDeadline};
  return next();
 }
 if(!state)return unchanged();
 if(event.kind==='tick')return now>=state.deadline?failed('READ_TIMEOUT'):unchanged();
 if(event.kind!=='reply')return unchanged();
 const msg=event.message,marker=msg&&msg._tleModbusCycle;
 if(!marker||marker.nonce!==state.nonce||marker.index!==state.index)return unchanged();
 if(now>=state.deadline)return failed('READ_TIMEOUT');
 if(msg.error)return failed(/timeout|timed out/i.test(String(msg.error.message||''))?'READ_TIMEOUT':'READ_FAILED');
 const chunk=modbusConfig.plan[state.index],request=msg.modbusRequest;
 if(!request||request.fc!==modbusConfig.fc||request.unitid!==modbusConfig.unitId||request.address!==chunk.address||request.quantity!==chunk.quantity
  ||!Array.isArray(msg.payload)||msg.payload.length!==chunk.quantity
  ||msg.payload.some(value=>!Number.isInteger(value)||value<0||value>65535))return failed('INVALID_RESPONSE');
 state.values.push(...msg.payload);state.index++;
 if(state.index===modbusConfig.plan.length)return {state:null,complete:state.values};
 return next();
};`;
}

/** One active round per collector. No pending poll queue and no partial telemetry. */
export function modbusAcquisitionScript(config: ModbusRoundConfig): string {
  return `${modbusRoundProgram(config)}
const holder=globalThis.__tleModbusAcquisition;
if(!holder)return null;
const complete=result=>{
 holder.round=result.state;
 if(result.request||result.complete||result.failure){if(holder.timer!==undefined)clearTimeout(holder.timer);holder.timer=undefined;}
 if(result.failure)node.error('Modbus 本轮采集未完成：'+result.failure,{error:{code:result.failure}});
 if(result.request){
  const nonce=result.state.nonce,index=result.state.index,run=holder.run;
  holder.timer=setTimeout(()=>{
   const current=globalThis.__tleModbusAcquisition;
   if(!current||current.run!==run||!current.round||current.round.nonce!==nonce||current.round.index!==index)return;
   const expired=advanceModbusRound(current.round,{kind:'tick'},Date.now());
   if(expired.failure){current.round=null;current.timer=undefined;node.error('Modbus 本轮采集未完成：'+expired.failure,{error:{code:expired.failure}});}
  },Math.max(1,result.state.deadline-Date.now()));
 }
 if(result.request)return [result.request,null];
 if(result.complete)return [null,{payload:result.complete}];
 return null;
};
if(msg._tleModbusPoll===true){
 if(holder.round){complete(advanceModbusRound(holder.round,{kind:'tick'},Date.now()));if(holder.round)return null;}
 holder.sequence++;
 return complete(advanceModbusRound(null,{kind:'start',nonce:holder.run+':'+holder.sequence},Date.now()));
}
return complete(advanceModbusRound(holder.round,{kind:'reply',message:msg},Date.now()));`;
}

// Node-RED gives each Function a private VM; never persist unfinished rounds or timers.
export const MODBUS_ACQUISITION_INITIALIZE = `const previous=globalThis.__tleModbusAcquisition;if(previous&&previous.timer!==undefined)clearTimeout(previous.timer);globalThis.__tleModbusAcquisition={run:String(Date.now())+':'+Math.random().toString(16).slice(2),sequence:0,round:null};`;
export const MODBUS_ACQUISITION_FINALIZE = `const current=globalThis.__tleModbusAcquisition;if(current&&current.timer!==undefined)clearTimeout(current.timer);globalThis.__tleModbusAcquisition=undefined;`;
