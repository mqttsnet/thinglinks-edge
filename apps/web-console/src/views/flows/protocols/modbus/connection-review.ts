import { MODBUS_MAX_REGISTER_RANGE, MODBUS_READ_BATCH_SIZE } from './read-limits.ts';

/** Configuration guidance only; it never implies that a connection was tested. */
export function reviewModbusConnection(values: Record<string, unknown>) {
  const notices: {code:'loopback'|'slow-polling'|'invalid-range'; message:string}[]=[];
  const host=typeof values.host==='string'?values.host.trim():'';
  const port=typeof values.port==='number'?values.port:502;
  const endpoint=host?`${host.includes(':')&&!host.startsWith('[')?`[${host}]`:host}:${port}`:'';
  if(/^(localhost\.?|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(host)) {
    notices.push({code:'loopback',message:'这个地址指向当前 Node-RED 实例自身。连接现场设备时，请填写设备的局域网地址；同实例模拟服务可以使用此地址。'});
  }
  const timeout=typeof values.clientTimeout==='number'?values.clientTimeout:2000;
  const readBatches = typeof values.quantity === 'number' && Number.isSafeInteger(values.quantity) && values.quantity > 0 && values.quantity <= MODBUS_MAX_REGISTER_RANGE ? Math.ceil(values.quantity / MODBUS_READ_BATCH_SIZE) : 1;
  if(typeof values.interval==='number'&&values.interval>0&&timeout*readBatches>=values.interval*1000) {
    notices.push({code:'slow-polling',message:'采集周期不大于本轮各批读取超时之和，慢响应时本轮可能超过设定周期。建议增大采集周期或缩短超时；当前数值不会被自动修改。'});
  }
  const start=values.address,quantity=values.quantity;
  const functionCode=values.registerType==='HoldingRegister'?3:values.registerType==='InputRegister'?4:undefined;
  let range: {start:number;end:number;quantity:number;functionCode:3|4;reference?:string}|undefined;
  if(typeof start==='number'&&typeof quantity==='number'&&Number.isSafeInteger(start)&&Number.isSafeInteger(quantity)
    &&start>=0&&quantity>=1&&quantity<=MODBUS_MAX_REGISTER_RANGE&&start+quantity<=65536&&functionCode) {
    const end=start+quantity-1;
    range={start,end,quantity,functionCode};
    if(end<=9998){const base=functionCode===3?40001:30001;range.reference=`${base+start}–${base+end}`;}
  }else if(start!==undefined&&quantity!==undefined) {
    notices.push({code:'invalid-range',message:`读取范围需使用整数协议地址，总计 1–${MODBUS_MAX_REGISTER_RANGE} 个寄存器，每批最多 ${MODBUS_READ_BATCH_SIZE} 个，末地址不得超过 65535。`});
  }
  return {endpoint,range,notices,batchCount:range?Math.ceil(range.quantity/MODBUS_READ_BATCH_SIZE):0};
}
