/** Fixed, dependency-free Node-RED Function body. User values enter only through JSON data. */
const BODY = `
try {
  const blocked = new Set(['__proto__', 'prototype', 'constructor']);
  let input = msg.payload;
  if (config.format === 'json') {
    if (Buffer.isBuffer(input)) input = input.toString('utf8');
    if (typeof input === 'string') input = JSON.parse(input);
    if (!input || typeof input !== 'object') throw new Error('数据必须是 JSON 对象');
  }
  if (config.format === 'registers') {
    if (!Array.isArray(input) || input.length > 2000) throw new Error('寄存器数据不是有效数组');
    const words = input;
    input = Buffer.alloc(words.length * 2);
    words.forEach((word, i) => {
      if (!Number.isInteger(word) || word < 0 || word > 65535) throw new Error('寄存器值越界');
      input.writeUInt16BE(word, i * 2);
    });
  }
  const output = {};
  for (const point of config.points) {
    if (!point.property || blocked.has(point.property)) throw new Error('属性编码不合法');
    let value;
    const numeric = { uint16be:['readUInt16BE',2], uint16le:['readUInt16LE',2],
      int16be:['readInt16BE',2], int16le:['readInt16LE',2],
      uint32be:['readUInt32BE',4], uint32le:['readUInt32LE',4],
      int32be:['readInt32BE',4], int32le:['readInt32LE',4],
      float32be:['readFloatBE',4], float32le:['readFloatLE',4] };
    if (Buffer.isBuffer(input)) {
      const offset = Number(point.source) * (config.format === 'registers' ? 2 : 1);
      const kind = point.dataType;
      const decoder = numeric[kind];
      const length = kind === 'float32swap' ? 4 : decoder && decoder[1];
      if (!Number.isInteger(offset) || offset < 0 || !length || offset + length > input.length) {
        throw new Error('点位偏移或报文长度不符合配置');
      }
      if (kind === 'float32swap') {
        const reordered = Buffer.from([input[offset+2],input[offset+3],input[offset],input[offset+1]]);
        value = reordered.readFloatBE(0);
      } else value = input[decoder[0]](offset);
    } else {
      value = input;
      for (const key of String(point.source).split('.')) {
        if (blocked.has(key) || value == null || !Object.prototype.hasOwnProperty.call(value,key)) {
          throw new Error('缺少配置的源字段');
        }
        value = value[key];
      }
      if(typeof value==='number' && (!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value)))) {
        throw new Error('点位超出安全数值范围，请在设备报文中使用字符串保存大整数');
      }
      if (point.dataType === 'number') {
        if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) {
          throw new Error('点位不是数值');
        }
        value = Number(value);
      } else if (point.dataType === 'boolean') {
        if (![true,false,0,1].includes(value)) throw new Error('点位不是布尔值');
        value = Boolean(value);
      } else if (point.dataType === 'string') {
        if (!['number','string','boolean'].includes(typeof value)) throw new Error('点位不是标量');
        value = String(value);
      } else throw new Error('未支持的数据类型');
    }
    if (typeof value === 'number') {
      if(Number.isInteger(value)&&!Number.isSafeInteger(value)) throw new Error('点位整数超出安全精度范围');
      value = value * point.scale + point.offset;
      if (!Number.isFinite(value)) throw new Error('点位不是有限数值');
      if(Number.isInteger(value)&&!Number.isSafeInteger(value)) throw new Error('换算后的整数超出安全精度范围');
    }
    output[point.property] = value;
  }
  msg.payload = output;
  msg.nodeId = config.nodeId;
  msg.serviceId = config.serviceCode;
  return msg;
} catch (error) {
  node.error('采集数据解析失败：' + error.message, msg);
  return null;
}`;

export interface TransformConfig {
  format: string;
  points: Record<string, unknown>[];
  nodeId: string;
  serviceCode: string;
}

export function transformScript(config: TransformConfig): string {
  return `const config = ${JSON.stringify(config)};\n${BODY}`;
}

/** OPC UA emits one scalar per variable; select its own mapping, never reuse another variable's value. */
export function opcuaTransformScript(
  nodeId: string,
  serviceCode: string,
  points: Record<string, unknown>[],
): string {
  return `const mappings=${JSON.stringify(points)};
const mapping=mappings.find((point)=>String(msg.topic).split(';datatype=')[0]===point.source);
if(!mapping){node.error('OPC UA 返回了未配置的变量',msg);return null;}
const status=msg.statusCode;
const quality=typeof status==='number'?status:status && status.value;
if(!Number.isInteger(quality)||quality<0||quality>0xffffffff||(quality>>>30)!==0){node.error('OPC UA 数据质量未确认或非 Good',msg);return null;}
const config={format:'json',nodeId:${JSON.stringify(nodeId)},serviceCode:${JSON.stringify(serviceCode)},
  points:[{...mapping,source:'value',dataType:mapping.dataType==='Boolean'?'boolean':mapping.dataType==='String'?'string':'number'}]};
msg.payload={value:msg.payload};\n${BODY}`;
}
