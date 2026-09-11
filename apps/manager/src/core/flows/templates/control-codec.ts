export interface ControlWriteOptions {
  nodeId: string;
  serviceCode: string;
  points: Record<string, unknown>[];
  mappings: { cmd: string; param: string; property: string }[];
  unitId?: number;
  address?: number;
  commandUrl?: string;
}

/**
 * Dependency-free Node-RED Function body. This prepares a write; it never reports
 * device success. The caller correlates the driver's response/acknowledgement.
 * Contracts were checked against Modbus 5.60.2 flex-write, OPC UA 0.2.355 client
 * and S7 3.1.3 output node HTML/JS in their integrity-verified published archives.
 */
const BODY = `
try {
  const command = msg.payload && msg.payload.command;
  delete msg._tleCommand;
  if (command === null) return null;
  const blocked = new Set(['__proto__', 'prototype', 'constructor']);
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
  if (!record(command) || !identifier(command.id) || !identifier(command.leaseToken)) {
    throw new Error('命令标识或租约标识无效');
  }
  msg._tleCommand = { id: command.id, leaseToken: command.leaseToken };
  // No Manager authorization, HTTP response state or dynamic transport target may reach a device.
  for (const key of ['headers','_headers','_requestHeaders','cookies','cookie','responseCookies',
    'auth','authorization','url','responseUrl','method','statusCode','redirectList','req','res',
    'proxy','tls','rejectUnauthorized','requestTimeout','followRedirects','qs','_session','socketid',
    'host','hostname','ip','port','server','endpoint','action','variable','topic','datatype']) delete msg[key];
  delete msg.payload;
  if (typeof config.nodeId !== 'string' || config.nodeId.length === 0 || config.nodeId.length > 128
    || typeof config.serviceCode !== 'string' || config.serviceCode.length === 0 || config.serviceCode.length > 128
    || command.deviceIdentification !== config.nodeId || command.serviceCode !== config.serviceCode) {
    throw new Error('命令设备或服务与配置不匹配');
  }
  if (typeof command.cmd !== 'string' || command.cmd.length === 0 || command.cmd.length > 128
    || !record(command.params)) throw new Error('命令编码或参数格式无效');
  const keys = Object.keys(command.params);
  if (keys.length !== 1 || blocked.has(keys[0])) throw new Error('命令必须只包含一个已声明参数');
  if (!Array.isArray(config.mappings) || config.mappings.length > 64
    || !Array.isArray(config.points) || config.points.length > 64) throw new Error('控制映射配置无效');
  const matches = config.mappings.filter((mapping) => record(mapping)
    && mapping.cmd === command.cmd && mapping.param === keys[0]);
  if (matches.length !== 1) throw new Error('命令参数没有唯一的控制映射');
  const mapping = matches[0];
  if (typeof mapping.property !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(mapping.property)
    || blocked.has(mapping.property)) throw new Error('控制属性编码无效');
  const points = config.points.filter((point) => record(point) && point.property === mapping.property);
  if (points.length !== 1) throw new Error('控制属性没有唯一的点位');
  const point = points[0];
  if (typeof point.source !== 'string' || point.source.length === 0 || point.source.length > 256
    || point.source.split('.').some((key) => blocked.has(key))) throw new Error('控制点位地址无效');
  const kind = typeof point.dataType === 'string' ? point.dataType.toLowerCase() : '';
  const scale = point.scale === undefined ? 1 : point.scale;
  const offset = point.offset === undefined ? 0 : point.offset;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale === 0
    || typeof offset !== 'number' || !Number.isFinite(offset)) throw new Error('控制换算倍率或偏移无效');
  const value = command.params[keys[0]];
  const ranges = {
    uint16:[0,65535], uint16be:[0,65535], uint16le:[0,65535],
    int16:[-32768,32767], int16be:[-32768,32767], int16le:[-32768,32767],
    uint32:[0,4294967295], uint32be:[0,4294967295], uint32le:[0,4294967295], uint32swap:[0,4294967295],
    int32:[-2147483648,2147483647], int32be:[-2147483648,2147483647],
    int32le:[-2147483648,2147483647], int32swap:[-2147483648,2147483647]
  };
  let raw;
  if (kind === 'boolean' || kind === 'string') {
    if (typeof value !== kind || (kind === 'string' && value.length > 4096)) throw new Error('控制值类型与点位不匹配');
    if (scale !== 1 || offset !== 0) throw new Error('布尔和文本控制点位不支持数值换算');
    raw = value;
  } else {
    if (!Object.prototype.hasOwnProperty.call(ranges, kind)
      && !['number','double','float','float32be','float32le','float32swap'].includes(kind)) {
      throw new Error('未支持的控制数据类型');
    }
    if (typeof value !== 'number' || !Number.isFinite(value)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('控制值不是安全有限数值');
    raw = (value - offset) / scale;
    if (!Number.isFinite(raw) || (Number.isInteger(raw) && !Number.isSafeInteger(raw))) {
      throw new Error('逆换算后的控制值超出安全范围');
    }
    const range = ranges[kind];
    if (range && (!Number.isInteger(raw) || raw < range[0] || raw > range[1])) throw new Error('控制整数超出点位范围');
    if (kind === 'float' || kind.startsWith('float32')) {
      const trial = Buffer.alloc(4); trial.writeFloatBE(raw, 0);
      const rounded = trial.readFloatBE(0);
      if (!Number.isFinite(rounded) || (raw !== 0 && rounded === 0)) throw new Error('控制浮点数超出32位范围');
    }
  }
  if (config.protocol === 'modbus-tcp') {
    const formats = {
      uint16be:['writeUInt16BE',2], uint16le:['writeUInt16LE',2],
      int16be:['writeInt16BE',2], int16le:['writeInt16LE',2],
      uint32be:['writeUInt32BE',4], uint32le:['writeUInt32LE',4], uint32swap:['writeUInt32BE',4],
      int32be:['writeInt32BE',4], int32le:['writeInt32LE',4], int32swap:['writeInt32BE',4],
      float32be:['writeFloatBE',4], float32le:['writeFloatLE',4], float32swap:['writeFloatBE',4]
    };
    const format = formats[kind];
    if (!format || typeof raw !== 'number') throw new Error('Modbus 控制需要寄存器数据类型');
    const base = config.address === undefined ? 0 : config.address;
    const unitid = config.unitId === undefined ? 1 : config.unitId;
    if (!Number.isInteger(base) || base < 0 || base > 65535 || !/^\\d+$/.test(point.source)) {
      throw new Error('Modbus 控制地址无效');
    }
    if (!Number.isInteger(unitid) || unitid < 1 || unitid > 247) throw new Error('Modbus 控制站号无效');
    const address = base + Number(point.source), quantity = format[1] / 2;
    if (!Number.isSafeInteger(address) || address < 0 || address + quantity > 65536) throw new Error('Modbus 控制地址越界');
    let bytes = Buffer.alloc(format[1]); bytes[format[0]](raw, 0);
    if (kind.endsWith('swap')) bytes = Buffer.from([bytes[2],bytes[3],bytes[0],bytes[1]]);
    const words = Array.from({length:quantity}, (_,index) => bytes.readUInt16BE(index*2));
    msg.payload = {value:quantity === 1 ? words[0] : words,fc:quantity === 1 ? 6 : 16,unitid,address,quantity};
  } else if (config.protocol === 'opcua') {
    if (!['Double','Float','Int16','UInt16','Int32','UInt32','Boolean','String'].includes(point.dataType)
      || !/^(ns=\\d+;)?[isgb]=.+$/.test(point.source) || point.source.includes(';datatype=')
      || /[\\r\\n]/.test(point.source)) throw new Error('OPC UA 控制变量或类型无效');
    msg.topic = point.source + ';datatype=' + point.dataType;
    msg.payload = raw;
  } else if (config.protocol === 's7') {
    // A generic acquisition "number" is insufficient for control: the PLC address selects the wire type.
    // Whitelist scalar NodeS7 1.1.2 addresses. Arrays, date/time and reversed aliases need separate codecs.
    const db = /^DB(\\d+),(REAL|INT|WORD|DINT|DWORD|BYTE|X|CHAR|STRING)(\\d+)(?:\\.(\\d+))?$/.exec(point.source);
    const area = /^([IQM])(DI|DW|B|W|I|D|R|C)?(\\d+)(?:\\.(\\d+))?$/.exec(point.source);
    if (!db && !area) throw new Error('S7 控制地址不在已验证的标量语法范围');
    const aliases = {DI:'DINT',DW:'DWORD',B:'BYTE',W:'WORD',I:'INT',D:'DWORD',R:'REAL',C:'CHAR'};
    const wireType = db ? db[2] : aliases[area[2]] || 'X';
    const byte = Number(db ? db[3] : area[3]);
    const suffix = db ? db[4] : area[4];
    if (db && (!Number.isInteger(Number(db[1])) || Number(db[1]) < 1 || Number(db[1]) > 65535)) {
      throw new Error('S7 数据块编号越界');
    }
    let width;
    if (wireType === 'X') {
      if (suffix === undefined || Number(suffix) > 7 || typeof raw !== 'boolean') throw new Error('S7 位地址或布尔控制类型无效');
      width = 1;
    } else if (wireType === 'STRING' || wireType === 'CHAR') {
      const capacity = wireType === 'CHAR' ? 1 : Number(suffix);
      if (wireType === 'CHAR' && suffix !== undefined) throw new Error('S7 字符数组控制尚未支持');
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 254 || typeof raw !== 'string'
        || !/^[\\x00-\\x7F]*$/.test(raw) || raw.length > capacity || (wireType === 'CHAR' && raw.length !== 1)) {
        throw new Error('S7 文本控制需要长度范围内的 ASCII 字符');
      }
      width = capacity + (wireType === 'STRING' ? 2 : 0);
    } else {
      if (suffix !== undefined || typeof raw !== 'number') throw new Error('S7 数值控制需要标量数值地址');
      const targetRanges = {BYTE:[0,255,1],INT:[-32768,32767,2],WORD:[0,65535,2],
        DINT:[-2147483648,2147483647,4],DWORD:[0,4294967295,4]};
      if (wireType === 'REAL') {
        const trial = Buffer.alloc(4); trial.writeFloatBE(raw, 0);
        const rounded = trial.readFloatBE(0);
        if (!Number.isFinite(rounded) || (raw !== 0 && rounded === 0)) throw new Error('S7 REAL 控制值超出32位浮点范围');
        width = 4;
      } else {
        const range = targetRanges[wireType];
        if (!range || !Number.isInteger(raw) || raw < range[0] || raw > range[1]) throw new Error('S7 控制整数超出实际 PLC 类型范围');
        width = range[2];
      }
    }
    if (!Number.isSafeInteger(byte) || byte < 0 || byte + width > 65536) throw new Error('S7 控制字节地址越界');
    msg.variable = point.property;
    msg.payload = raw;
  } else if (config.protocol === 'http') {
    const url = new URL(config.commandUrl);
    if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error('HTTP 控制地址无效或含内联凭据');
    }
    const path = point.source.split('.');
    if (path.length > 16 || path.some((key) => !/^[A-Za-z0-9_-]{1,64}$/.test(key) || blocked.has(key))) {
      throw new Error('HTTP 控制字段路径无效');
    }
    const payload = {};
    let target = payload;
    for (const key of path.slice(0,-1)) target = target[key] = {};
    target[path[path.length-1]] = raw;
    msg.method = 'POST'; msg.url = url.toString(); msg.headers = {'content-type':'application/json'};
    msg.payload = payload;
  } else if (config.protocol === 'tcp' || config.protocol === 'udp') {
    // Only devices that explicitly implement this JSON request/response contract are compatible.
    msg.payload = JSON.stringify({requestId:command.id,cmd:command.cmd,params:{[point.source]:raw}});
  } else throw new Error('当前协议没有可用的控制编码器');
  return msg;
} catch (error) {
  node.error('控制数据校验失败：' + error.message, msg);
  return null;
}`;

export function controlWriteScript(protocol: string, options: ControlWriteOptions): string {
  // JSON.parse avoids object-literal __proto__ semantics as well as code interpolation.
  const encoded = JSON.stringify({ ...options, protocol });
  return `const config = JSON.parse(${JSON.stringify(encoded)});\n${BODY}`;
}
