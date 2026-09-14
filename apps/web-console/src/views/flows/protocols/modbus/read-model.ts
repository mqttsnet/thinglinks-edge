import type { ModbusReadConnection } from '../../../../api/types.ts';

export function modbusReadConnection(values: Record<string, unknown>): { connection?: ModbusReadConnection; issues: string[] } {
  const issues: string[] = [];
  const host = typeof values.host === 'string' ? values.host.trim() : '';
  if (!host) issues.push('请填写设备地址');
  function integer(key: string, label: string, fallback: number, min: number, max: number): number {
    const value = values[key] === undefined ? fallback : values[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      issues.push(`${label}需为 ${min}–${max} 的整数`); return fallback;
    }
    return value;
  }
  const registerType = values.registerType ?? 'HoldingRegister';
  if (!['HoldingRegister', 'InputRegister'].includes(String(registerType))) issues.push('请选择 FC3 或 FC4');
  const connection: ModbusReadConnection = {
    host, port: integer('port', '端口', 502, 1, 65535), unitId: integer('unitId', '站号', 1, 0, 255),
    registerType: registerType as ModbusReadConnection['registerType'],
    address: integer('address', '起始地址', 0, 0, 65535), quantity: integer('quantity', '读取数量', 2, 1, 125),
    clientTimeout: integer('clientTimeout', '读取超时', 2000, 100, 60000),
    reconnectTimeout: integer('reconnectTimeout', '重连间隔', 5000, 100, 60000),
  };
  if (connection.address + connection.quantity > 65536) issues.push('读取范围越过协议地址 65535');
  return issues.length ? { issues } : { connection, issues };
}

export function sameReadConnection(first: Record<string, unknown>, second: Record<string, unknown>): boolean {
  const a = modbusReadConnection(first).connection, b = modbusReadConnection(second).connection;
  return Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
}

export interface RegisterPointPreview { property: string; raw?: number; value?: number; error?: string }
const readers: Record<string, (view: DataView, offset: number) => number> = {
  uint16be: (view, offset) => view.getUint16(offset), uint16le: (view, offset) => view.getUint16(offset, true),
  int16be: (view, offset) => view.getInt16(offset), int16le: (view, offset) => view.getInt16(offset, true),
  uint32be: (view, offset) => view.getUint32(offset), uint32le: (view, offset) => view.getUint32(offset, true),
  int32be: (view, offset) => view.getInt32(offset), int32le: (view, offset) => view.getInt32(offset, true),
  float32be: (view, offset) => view.getFloat32(offset), float32le: (view, offset) => view.getFloat32(offset, true),
};

/** Local sample calculation, using the same 16-bit word layout as the generated flow. */
export function previewRegisterPoints(registers: number[], points: unknown): RegisterPointPreview[] {
  if (!Array.isArray(points)) return [];
  const valid = registers.length <= 125 && registers.every(word => Number.isInteger(word) && word >= 0 && word <= 65535);
  const bytes = new Uint8Array((valid ? registers.length : 0) * 2), view = new DataView(bytes.buffer);
  if (valid) registers.forEach((word, i) => view.setUint16(i * 2, word));
  return points.slice(0, 64).map((candidate: unknown, index: number) => {
    const point = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
    const property = typeof point.property === 'string' && point.property ? point.property : `点位 ${index + 1}`;
    try {
      if (!valid) throw new Error('试读返回的寄存器无效');
      const kind = String(point.dataType), source = String(point.source), offset = Number(source) * 2;
      const reader = Object.hasOwn(readers, kind) ? readers[kind] : undefined;
      if (!reader && kind !== 'float32swap') throw new Error('请选择支持的数据类型');
      const length = kind.includes('16') ? 2 : 4;
      if (!/^\d+$/.test(source) || !Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.length) throw new Error('点位超出本次试读范围');
      const raw = kind === 'float32swap'
        ? new DataView(Uint8Array.from([bytes[offset + 2]!, bytes[offset + 3]!, bytes[offset]!, bytes[offset + 1]!]).buffer).getFloat32(0)
        : reader!(view, offset);
      const scale = point.scale === undefined ? 1 : point.scale, shift = point.offset === undefined ? 0 : point.offset;
      if (typeof scale !== 'number' || !Number.isFinite(scale) || Math.abs(scale) > 1e12
        || typeof shift !== 'number' || !Number.isFinite(shift) || Math.abs(shift) > 1e12) throw new Error('请填写有效的倍率和偏移');
      const value = raw * scale + shift;
      if (![raw, value].every(number => Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number)))) throw new Error('换算值无法安全表示');
      return { property, raw, value };
    } catch (error) { return { property, error: error instanceof Error ? error.message : '点位换算失败' }; }
  });
}
