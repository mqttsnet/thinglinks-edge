import { MODBUS_MAX_REGISTER_RANGE } from './read-limits.ts';
import { tableRowLimit } from '../../components/table-pagination.ts';
import { parseRows, conversionNumber, MAX_POINT_IMPORT_TEXT_LENGTH, type TextRow } from '../shared/delimited-text.ts';
import { pointImportColumns, POINT_IMPORT_HEADER_HELP } from '../shared/point-import-columns.ts';
import { effectiveService, servicePointKey, validServiceCode, MAX_TEMPLATE_SERVICES } from '../../service-identity.ts';
/** Mirrors the Modbus point schema in manager/core/flows/templates/builtin/common.ts. */
export const MODBUS_IMPORT_TYPES = [
  'uint16be', 'uint16le', 'int16be', 'int16le',
  'uint32be', 'uint32le', 'int32be', 'int32le',
  'float32be', 'float32le', 'float32swap',
] as const;

export type ModbusImportMode = 'relative' | 'absolute' | 'manual';
export interface ModbusImportPoint {
  source: string;
  property: string;
  dataType: string;
  scale: number;
  offset: number;
  serviceCode?: string;
}
export interface ModbusImportRow {
  line: number;
  enteredAddress: string;
  protocolAddress: number;
  words: number;
  point: ModbusImportPoint;
}
export interface ModbusImportPreview {
  mode: ModbusImportMode;
  rows: ModbusImportRow[];
  issues: string[];
  address: number | null;
  quantity: number | null;
  unusedRegisters: number;
}

export function previewModbusPointImport(
  text: string, mode: ModbusImportMode, values: Record<string, unknown>, schema: { max?: number } = {},
): ModbusImportPreview {
  const result: ModbusImportPreview = { mode, rows: [], issues: [], address: null, quantity: null, unusedRegisters: 0 };
  const issues = result.issues;
  if (!['relative', 'absolute', 'manual'].includes(mode)) { issues.push('请选择明确的地址解释方式。'); return result; }
  if (text.length > MAX_POINT_IMPORT_TEXT_LENGTH) { issues.push('点表文本超过 256 Ki 字符，请拆分后导入。'); return result; }
  if (!['HoldingRegister', 'InputRegister'].includes(String(values.registerType))) {
    issues.push('请先选择保持寄存器（FC3）或输入寄存器（FC4）。');
  }
  let records: TextRow[];
  try { records = parseRows(text.replace(/^\uFEFF/, '')); }
  catch (error) { issues.push(error instanceof Error ? error.message : '点表文本无法解析。'); return result; }
  const header = records.shift();
  const indices = pointImportColumns(header?.cells);
  if (!header || !indices) {
    issues.push(POINT_IMPORT_HEADER_HELP);
    return result;
  }
  if (records.length === 0) { issues.push('点表没有数据行，请在表头下方填写点位。'); return result; }
  const maxPoints = tableRowLimit(schema);
  if (records.length > maxPoints) { issues.push(`点表包含 ${records.length} 个点位，单次最多 ${maxPoints} 个，请拆分导入。`); return result; }
  if (mode === 'relative') {
    const { address, quantity } = values;
    if (typeof address !== 'number' || !Number.isInteger(address) || address < 0 || address > 65535 ||
        typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MODBUS_MAX_REGISTER_RANGE || address + quantity > 65536) {
      issues.push(`请先设置有效的起始地址（0–65535）与读取数量（1–${MODBUS_MAX_REGISTER_RANGE}），读取范围不能越过地址 65535。`);
    } else { result.address = address; result.quantity = quantity; }
  }
  const properties = new Set<string>(), services = new Set<string>();
  for (const { cells, line } of records) {
    const fail = (message: string) => issues.push(`第 ${line} 行：${message}`);
    if (cells.length !== header.cells.length) { fail('数据列数须与表头一致；服务编码列为可选第六列。'); continue; }
    const cell = (key: string) => (cells[indices.get(key)!] ?? '').trim();
    const source = cell('source'), property = cell('property'), rawType = cell('dataType'), scaleText = cell('scale'), offsetText = cell('offset');
    const serviceCode = cell('serviceCode'), service = effectiveService(serviceCode, values.serviceCode);
    if (service && !validServiceCode(service)) { fail('服务编码格式无效，最多 128 个字母、数字、下划线、短横线或点。'); continue; }
    if (service) services.add(service);
    let protocolAddress = Number(source);
    if (source.length > 256 || !/^\d+$/.test(source) || !Number.isSafeInteger(protocolAddress) || protocolAddress > 65535) {
      fail('地址必须是 0–65535 的十进制整数。'); continue;
    }
    if (mode === 'manual') {
      const holding = values.registerType === 'HoldingRegister';
      const base = holding ? 40001 : 30001;
      if (!/^\d{5}$/.test(source) || protocolAddress < base || protocolAddress > base + 9998) {
        fail(`手册地址与${holding ? '保持寄存器（FC3，40001–49999）' : '输入寄存器（FC4，30001–39999）'}不一致；其他编号规则请使用零基协议地址。`);
        continue;
      }
      protocolAddress -= base;
    }
    if (mode === 'relative') protocolAddress += result.address ?? 0;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(property) || ['__proto__', 'prototype', 'constructor'].includes(property)) {
      fail('属性编码须以字母或下划线开头，仅含字母、数字、下划线，最多 64 个字符；不能使用保留名称。'); continue;
    }
    const identity = servicePointKey(service, property);
    if (properties.has(identity)) { fail(`服务 ${service || '默认服务'} 的属性编码 ${property} 重复。`); continue; }
    properties.add(identity);
    const dataType = rawType.toLowerCase();
    if (!(MODBUS_IMPORT_TYPES as readonly string[]).includes(dataType)) { fail(`数据类型 ${rawType || '为空'}，请选择支持的 16 位或 32 位类型。`); continue; }
    const scale = conversionNumber(scaleText, 1), offset = conversionNumber(offsetText, 0);
    if (scale === null) { fail('倍率必须是 -1e12 至 1e12 之间的有限数值，留空时为 1。'); continue; }
    if (offset === null) { fail('偏移必须是 -1e12 至 1e12 之间的有限数值，留空时为 0。'); continue; }
    const words = dataType.includes('16') ? 1 : 2;
    if (protocolAddress + words > 65536) { fail('点位完整宽度越过地址 65535。'); continue; }
    if (mode === 'relative' && result.quantity !== null && Number(source) + words > result.quantity) {
      fail(`${words === 2 ? '32 位点位占 2 个寄存器，' : ''}点位超出当前读取范围，请先调整读取数量。`); continue;
    }
    result.rows.push({ line, enteredAddress: source, protocolAddress, words, point: { source, property, dataType, scale, offset, ...(indices.has('serviceCode') ? { serviceCode } : {}) } });
  }
  if (services.size > MAX_TEMPLATE_SERVICES) issues.push(`点表涉及 ${services.size} 个服务，最多 ${MAX_TEMPLATE_SERVICES} 个。`);
  if (mode !== 'relative' && result.rows.length) {
    result.address = Math.min(...result.rows.map((row) => row.protocolAddress));
    result.quantity = Math.max(...result.rows.map((row) => row.protocolAddress + row.words)) - result.address;
    if (result.quantity > MODBUS_MAX_REGISTER_RANGE) issues.push(`这些点位需要连续读取 ${result.quantity} 个寄存器，超过 ${MODBUS_MAX_REGISTER_RANGE} 个；请按地址区间拆成多个流程。`);
  }
  if (result.address !== null && result.quantity !== null) {
    const occupied = new Set<number>();
    for (const row of result.rows) {
      row.point.source = String(row.protocolAddress - result.address);
      for (let word = 0; word < row.words; word++) occupied.add(row.protocolAddress + word);
    }
    result.unusedRegisters = Math.max(0, result.quantity - occupied.size);
  }
  return result;
}

export function applyModbusPointImport(values: Record<string, unknown>, preview: ModbusImportPreview): Record<string, unknown> {
  if (preview.issues.length || !preview.rows.length || preview.address === null || preview.quantity === null) {
    throw new Error('点表校验未通过，不能替换现有点位。');
  }
  return { ...values, address: preview.address, quantity: preview.quantity, points: preview.rows.map((row) => ({ ...row.point })) };
}
