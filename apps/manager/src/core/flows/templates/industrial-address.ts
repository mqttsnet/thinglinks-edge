import { TemplateError } from '../types.ts';
import type { TemplateParameter } from './types.ts';
import { endpoint } from './builtin/common.ts';

/** Same explicit namespace/GUID representation used by the pinned node-opcua NodeId.toString(). */
export function normalizeOpcuaNodeId(value: unknown): string {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value) || value.includes(';datatype='))
    throw new TemplateError('OPC UA NodeId 不得包含控制字符或 ;datatype= 附加字段');
  const match = /^(?:ns=(\d+);)?([isgb])=(.+)$/u.exec(value);
  if (!match) throw new TemplateError('OPC UA NodeId 应为 ns=2;s=Temperature、ns=2;i=123 等标准形式');
  const namespace = Number(match[1] ?? 0), kind = match[2]!;
  let identifier = match[3]!;
  if (!Number.isSafeInteger(namespace) || namespace > 65535) throw new TemplateError('OPC UA NodeId 命名空间编号应为 0–65535');
  if (kind === 'i') {
    const numeric = Number(identifier);
    if (!/^\d+$/.test(identifier) || !Number.isSafeInteger(numeric) || numeric > 0xffffffff)
      throw new TemplateError('OPC UA NodeId 的 i= 标识应为 0–4294967295 的整数');
    identifier = String(numeric);
  } else if (kind === 'g') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier))
      throw new TemplateError('OPC UA NodeId 的 g= 标识应为完整 GUID');
    identifier = identifier.toUpperCase();
  } else if (kind === 'b') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(identifier)
      || Buffer.from(identifier, 'base64').toString('base64') !== identifier)
      throw new TemplateError('OPC UA NodeId 的 b= 标识应为标准 Base64 字节串');
  } else if (identifier.length > 4096) throw new TemplateError('OPC UA NodeId 的字符串标识不能超过 4096 字符');
  return `ns=${namespace};${kind}=${identifier}`;
}

export function opcuaEndpoint(value: unknown): string {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) throw new TemplateError('OPC UA 服务地址不能包含控制字符');
  const url = endpoint(value, ['opc.tcp:']), parsed = new URL(url);
  if (parsed.search) throw new TemplateError('OPC UA 服务地址不能包含查询参数');
  if (parsed.port && Number(parsed.port) < 1) throw new TemplateError('OPC UA 服务端口应为 1–65535');
  return url;
}

export function opcuaPointTable(field: TemplateParameter): TemplateParameter {
  return { ...field, description: '从服务器复制完整 NodeId。ns 是命名空间编号；s= 后是区分大小写的字符串标识，i= 后是数字标识。请勿把浏览名称、数据类型后缀或变量值填入地址。',
    ...(field.columns ? { columns: field.columns.map(column => column.key === 'source' ? { ...column, preserveWhitespace: true } : column) } : {}) };
}

const rowLabel = (point: Record<string, unknown>, index: number) => `点位第 ${index + 1} 行（${String(point.property)}）`;
function scalarConversion(point: Record<string, unknown>): void {
  if (['Boolean', 'String', 'boolean', 'string'].includes(String(point.dataType)) && (point.scale !== 1 || point.offset !== 0))
    throw new TemplateError('布尔和文本点位不支持数值倍率或偏移');
}

/** Normalize the actual targets once, so read, control and returned parameterValues use one identity. */
export function normalizeOpcuaPoints(points: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return points.map((point, index) => {
    try {
      const source = normalizeOpcuaNodeId(point.source);
      if (seen.has(source)) throw new TemplateError('OPC UA NodeId 重复，同一变量请只配置一次');
      scalarConversion(point); seen.add(source);
      return { ...point, source };
    } catch (error) { throw new TemplateError(`${rowLabel(point, index)}：${(error as Error).message}`); }
  });
}

const s7Aliases: Record<string, string> = { B: 'BYTE', C: 'CHAR', S: 'STRING', I: 'INT', DI: 'DINT', W: 'WORD', D: 'DWORD', DW: 'DWORD', R: 'REAL', RI: 'RINT', RDI: 'RDINT', RW: 'RWORD', RD: 'RDWORD', RDW: 'RDWORD', RR: 'RREAL' };
const s7Widths: Record<string, number> = { BYTE: 1, INT: 2, WORD: 2, DINT: 4, DWORD: 4, REAL: 4, RINT: 2, RWORD: 2, RDINT: 4, RDWORD: 4, RREAL: 4, TIMER: 2, COUNTER: 2 };
export function s7ScalarAddress(value: unknown): { kind: 'number' | 'boolean' | 'string'; width: number } {
  const match = typeof value === 'string' && /^(?:DB(\d+),)?([A-Z]+)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
  if (!match) throw new TemplateError('PLC 地址请使用 DB1,REAL0、DB1,X0.1、MW0 等 NodeS7 格式；Step7 地址需先明确数据类型');
  let type = match[2]!;
  if (match[1] !== undefined) {
    const db = Number(match[1]);
    if (!Number.isSafeInteger(db) || db < 1 || db > 65535) throw new TemplateError('S7 数据块编号应为 1–65535');
    type = s7Aliases[type] ?? type;
  } else {
    const area = /^(PI|PE|PQ|PA|[IEQAMTC])(.*)$/.exec(type);
    if (!area) throw new TemplateError('PLC 地址区域不受支持');
    const suffix = area[2]!;
    if (suffix && !s7Aliases[suffix]) throw new TemplateError('PLC 地址的数据类型不受支持');
    type = suffix ? s7Aliases[suffix]! : area[1] === 'T' ? 'TIMER' : area[1] === 'C' ? 'COUNTER' : 'X';
  }
  if (['DT', 'DTZ', 'DTL', 'DTLZ'].includes(type)) throw new TemplateError('日期时间地址需在自定义流程转换，当前模板仅处理标量数值、布尔和文本');
  let kind: 'number' | 'boolean' | 'string' = 'number', width = s7Widths[type] ?? 0;
  const first = match[4] === undefined ? undefined : Number(match[4]);
  const second = match[5] === undefined ? undefined : Number(match[5]);
  if (type === 'X') {
    if (first === undefined || !Number.isSafeInteger(first) || first > 7) throw new TemplateError('PLC 位地址必须包含 0–7 的位偏移');
    if (second !== undefined && second !== 1) throw new TemplateError('位数组地址需拆成单点，当前模板不支持数组');
    kind = 'boolean'; width = 1;
  } else if (type === 'STRING') {
    if (!Number.isSafeInteger(first) || first! < 1 || first! > 254) throw new TemplateError('PLC STRING 文本地址必须指定 1–254 的容量，例如 DB1,STRING0.20');
    if (second !== undefined && second !== 1) throw new TemplateError('文本数组地址需拆成单点，当前模板不支持数组');
    kind = 'string'; width = first! + 2;
  } else if (type === 'CHAR') {
    if (second !== undefined || (first !== undefined && (!Number.isSafeInteger(first) || first < 1))) throw new TemplateError('PLC CHAR 文本地址的长度无效');
    kind = 'string'; width = first ?? 1; // nodes7 returns a CHAR array as one String.
  } else {
    if (!width) throw new TemplateError('PLC 地址的数据类型不受支持');
    if (second !== undefined || (first !== undefined && first !== 1)) throw new TemplateError('数值数组地址需拆成单点，当前模板不支持数组');
  }
  const offset = Number(match[3]);
  // nodes7 serializes byte offsets as a 24-bit bit address; do not apply the narrower write codec limit here.
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(width) || offset + width > 0x200000) throw new TemplateError('PLC 地址及数据宽度超出 S7 24 位地址范围');
  return { kind, width };
}

export function validateS7Points(points: Record<string, unknown>[]): void {
  for (const [index, point] of points.entries()) {
    try {
      const address = s7ScalarAddress(point.source); scalarConversion(point);
      if (address.kind === 'boolean' && point.dataType === 'number') throw new TemplateError('PLC 位地址返回布尔值，请选择布尔或文本类型');
      if (address.kind === 'string' && point.dataType === 'boolean') throw new TemplateError('PLC 文本地址不能直接转换为布尔值');
    } catch (error) { throw new TemplateError(`${rowLabel(point, index)}：${(error as Error).message}`); }
  }
}
