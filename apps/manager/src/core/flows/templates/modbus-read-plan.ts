import { TemplateError } from '../types.ts';

export const MODBUS_REQUEST_REGISTERS = 125;
export const MAX_MODBUS_REGISTERS = 600;
export const MODBUS_RESPONSE_GRACE_MS = 250;

/** Complete-round response budget; callers reserve connection/reporting time separately. */
export function modbusReadDurationMs(quantity: number, clientTimeout: number): number {
  const plan = modbusReadPlan(0, quantity);
  if (!Number.isSafeInteger(clientTimeout) || clientTimeout < 100 || clientTimeout > 60000) throw new TemplateError('Modbus 读取超时无效');
  return plan.length * (clientTimeout + MODBUS_RESPONSE_GRACE_MS);
}

export interface ModbusReadChunk {
  index: number;
  offset: number;
  address: number;
  quantity: number;
}

/** One continuous range, bounded for 300 two-register points. No address holes are skipped. */
export function modbusReadPlan(address: number, quantity: number): ModbusReadChunk[] {
  if (!Number.isSafeInteger(address) || address < 0 || address > 65535
    || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_MODBUS_REGISTERS) {
    throw new TemplateError(`Modbus 起始地址须为 0–65535，读取总量须为 1–${MAX_MODBUS_REGISTERS} 个寄存器`);
  }
  if (address + quantity > 65536) {
    throw new TemplateError(`寄存器读取范围 ${address}–${address + quantity - 1} 超出 0–65535；请减少读取数量或调整起始地址`);
  }
  const chunks: ModbusReadChunk[] = [];
  for (let offset = 0; offset < quantity; offset += MODBUS_REQUEST_REGISTERS) {
    chunks.push({ index: chunks.length, offset, address: address + offset, quantity: Math.min(MODBUS_REQUEST_REGISTERS, quantity - offset) });
  }
  return chunks;
}
