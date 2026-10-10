import { TemplateError } from '../../types.ts';
import type { TemplateRecipe } from '../types.ts';
import { MAX_MODBUS_REGISTERS, modbusReadDurationMs } from '../modbus-read-plan.ts';
import { modbusAcquisitionScript, MODBUS_ACQUISITION_INITIALIZE, MODBUS_ACQUISITION_FINALIZE } from '../modbus-acquisition.ts';
import {
  identityFields,
  hostField,
  portField,
  intervalField,
  pointTable,
  binaryTypes,
  requirements,
  notes,
  integer,
  host,
  pipeline,
  pointsOf,
  functionNode,
  injectNode,
} from './common.ts';

export const modbusRecipe: TemplateRecipe = {
  id: 'builtin:modbus-tcp',
  name: 'Modbus-TCP 寄存器采集上云',
  description: '读取保持/输入寄存器，支持多点位、有符号数、浮点数与常见字节序。',
  category: 'industrial',
  protocols: ['modbus-tcp'],
  revision: '1.3.0',
  previewParameters: { host: '192.0.2.1' },
  controlSupported: false,
  requirements: requirements('modbus-tcp'),
  parameters: [
    ...identityFields,
    {
      ...hostField,
      required: true,
      default: '',
      description: '填写实例可访问的设备 IP 或主机名。127.0.0.1 指实例自身，不能用于连接实例外的设备。',
    },
    {
      ...portField(502),
      description: '远端设备的 Modbus-TCP 服务端口，通常为 502；主动采集不需要为实例配置入站端口映射。',
    },
    {
      key: 'unitId', label: '单元标识 Unit ID', type: 'number', default: 1, min: 0, max: 255,
      description: '通过串口网关采集时通常使用从站地址 1–247；直连 TCP 设备按手册填写，可能使用 0 或 255。此模板只执行 FC3/FC4 读取，不发送广播写入。',
    },
    {
      key: 'registerType',
      label: '寄存器类型',
      type: 'select',
      default: 'HoldingRegister',
      options: [
        { label: '保持寄存器（FC3）', value: 'HoldingRegister' },
        { label: '输入寄存器（FC4）', value: 'InputRegister' },
      ],
    },
    {
      key: 'address',
      label: '起始地址（从 0 开始）',
      type: 'number',
      default: 0,
      min: 0,
      max: 65535,
      description: '填写协议地址，不直接填写手册编号。手册中的 40001 常对应地址 0，30001 常对应输入寄存器地址 0，请按设备说明确认。',
    },
    {
      key: 'quantity',
      label: '读取寄存器数量',
      type: 'number',
      default: 2,
      min: 1,
      max: MAX_MODBUS_REGISTERS,
      description: '一轮读取的连续 16 位寄存器总量，最多 600，不是点位数量。16 位点位占 1 个寄存器，32 位点位占 2 个；超过 125 时自动串行分批，整轮成功后统一上报。',
    },
    {
      ...intervalField,
      description: '建议大于整轮分批读取的耗时。上一轮未结束时跳过本次触发，不积压请求；每批读取超时在高级设置调整。',
    },
    {
      key: 'clientTimeout',
      label: '读取超时（毫秒）',
      type: 'number',
      default: 2000,
      min: 100,
      max: 60000,
      group: 'advanced',
      description: '等待单次设备读取响应的最长时间，范围 100–60000 毫秒。建议小于采集周期，兼顾设备响应速度与异常发现时间。',
    },
    {
      key: 'reconnectTimeout',
      label: '重连间隔（毫秒）',
      type: 'number',
      default: 5000,
      min: 100,
      max: 60000,
      group: 'advanced',
      description: '连接失败或超时后等待多久再次连接，范围 100–60000 毫秒。过短可能增加设备和网络负担，不会改变正常采集周期。',
    },
    {
      ...pointTable({ sourceLabel: '寄存器相对偏移', sourceDefault: '0', types: binaryTypes }),
      description: '相对偏移从 0 开始，0 表示本次读取的第一个寄存器；不是设备绝对地址或字节偏移。换算结果 = 原始值 × 倍率 + 偏移。',
    },
  ],
  notes: [
    ...notes,
    '连续范围最多 600 个寄存器，每个原生请求最多 125 个，使用同一连接逐批读取。任一批失败或超时会丢弃整轮，后续周期重新读取；不会把不同轮次的数据拼在一起上报。',
    '范围中的空隙也会被读取。分批不是 PLC 同一时刻的原子快照；变化快速、要求多寄存器一致性的设备需使用其锁存或快照机制。',
    '有效寄存器采样维持在线；明确连接失败或持续重连窗口后上报离线。寄存器异常、点位配置错误和数据质量错误不直接等同于设备断线。',
    '点位偏移相对于本次读取的起始地址；16 位占 1 个寄存器，32 位占 2 个。设备手册中的 40001 常对应地址 0，须按设备说明确认。',
  ],
  build(p) {
    const remote = host(p.host),
      port = integer(p.port, '端口'),
      address = integer(p.address, '起始地址'),
      quantity = integer(p.quantity, '寄存器数量'),
      clientTimeout = integer(p.clientTimeout, '读取超时'),
      reconnectTimeout = integer(p.reconnectTimeout, '重连间隔');
    if (address + quantity > 65536) {
      throw new TemplateError(
        `寄存器读取范围 ${address}–${address + quantity - 1} 超出 0–65535；请减少读取数量或调整起始地址`,
      );
    }
    for (const [index, point] of pointsOf(p).entries()) {
      const offset = Number(point.source),
        words = String(point.dataType).includes('16') ? 1 : 2,
        label = `点位第 ${index + 1} 行（${String(point.property)}）`;
      if (!/^\d+$/.test(String(point.source)) || !Number.isSafeInteger(offset)) {
        throw new TemplateError(
          `${label}：寄存器相对偏移必须为非负安全整数，本次可用偏移为 0–${quantity - 1}`,
        );
      }
      if (offset + words > quantity) {
        throw new TemplateError(
          `${label}：${String(point.dataType)} 占用 ${words} 个寄存器，` +
          `需要相对区间 ${offset}–${offset + words - 1}` +
          `（设备地址 ${address + offset}–${address + offset + words - 1}），` +
          `本次只读取相对区间 0–${quantity - 1}；请增加读取数量或调整偏移、类型`,
        );
      }
    }
    return pipeline(
      p,
      'Modbus-TCP 采集',
      'modbus-tcp',
      `${remote}:${port}`,
      [
        {
          id: 'connection', z: 'tab',
          type: 'modbus-client',
          name: 'Modbus 连接',
          clienttype: 'tcp',
          bufferCommands: false,
          stateLogEnabled: false,
          queueLogEnabled: false,
          failureLogEnabled: true,
          tcpHost: remote,
          tcpPort: port,
          tcpType: 'DEFAULT',
          unit_id: integer(p.unitId, '站号'),
          commandDelay: 10,
          clientTimeout,
          reconnectOnTimeout: true,
          reconnectTimeout,
          parallelUnitIdsAllowed: false,
        },
        { ...injectNode('modbus-poll', Number(p.interval), [['modbus-cycle']]),
          props: [{ p: '_tleModbusPoll', v: 'true', vt: 'bool' }] },
        { ...functionNode('modbus-cycle', '分批读取与整轮确认', modbusAcquisitionScript({
          address, quantity, unitId: integer(p.unitId, '站号'), fc: p.registerType === 'InputRegister' ? 4 : 3, clientTimeout,
        }), [['input'], ['decode']]), initialize: MODBUS_ACQUISITION_INITIALIZE, finalize: MODBUS_ACQUISITION_FINALIZE },
        {
          id: 'input',
          type: 'modbus-flex-getter',
          z: 'tab',
          name: '读取寄存器',
          topic: '',
          showStatusActivities: true,
          logIOActivities: false,
          showErrors: true,
          showWarnings: true,
          delayOnStart: false,
          startDelayTime: 1,
          server: 'connection',
          useIOFile: false,
          ioFile: '',
          useIOForPayload: false,
          emptyMsgOnFail: true,
          keepMsgProperties: true,
          enableDeformedMessages: false,
          x: 160,
          y: 160,
          wires: [['modbus-cycle'], []],
        },
        { id: 'modbus-read-errors', type: 'catch', z: 'tab', name: '终止失败的采集轮次', scope: ['input'], uncaught: false,
          x: 160, y: 410, wires: [['modbus-cycle']] },
      ],
      'registers',
      pointsOf(p),
      { protocol: 'modbus', sourceIds: ['input', 'connection'], failureWindowMs: Math.ceil(Math.max(10000, Number(p.interval) * 3000 + modbusReadDurationMs(quantity, clientTimeout))) },
    );
  },
};
