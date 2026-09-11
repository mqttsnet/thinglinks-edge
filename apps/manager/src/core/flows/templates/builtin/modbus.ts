import { TemplateError } from '../../types.ts';
import type { TemplateRecipe } from '../types.ts';
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
} from './common.ts';

export const modbusRecipe: TemplateRecipe = {
  id: 'builtin:modbus-tcp',
  name: 'Modbus-TCP 寄存器采集上云',
  description: '读取保持/输入寄存器，支持多点位、有符号数、浮点数与常见字节序。',
  category: 'industrial',
  protocols: ['modbus-tcp'],
  revision: '1.0.0',
  controlSupported: false,
  requirements: requirements('modbus-tcp'),
  parameters: [
    ...identityFields,
    { ...hostField, required: true, default: '127.0.0.1' },
    portField(502),
    { key: 'unitId', label: '站号', type: 'number', default: 1, min: 1, max: 247 },
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
    { key: 'address', label: '起始地址（从 0 开始）', type: 'number', default: 0, min: 0, max: 65535 },
    { key: 'quantity', label: '读取寄存器数量', type: 'number', default: 2, min: 1, max: 125 },
    intervalField,
    pointTable({ sourceLabel: '寄存器相对偏移', sourceDefault: '0', types: binaryTypes }),
  ],
  notes: [
    ...notes,
    '点位偏移相对于本次读取的起始地址；16 位占 1 个寄存器，32 位占 2 个。设备手册中的 40001 常对应地址 0，须按设备说明确认。',
  ],
  build(p) {
    const remote = host(p.host),
      port = integer(p.port, '端口'),
      address = integer(p.address, '起始地址'),
      quantity = integer(p.quantity, '寄存器数量');
    if (address + quantity > 65536) throw new TemplateError('寄存器读取范围越界');
    for (const point of pointsOf(p)) {
      const offset = Number(point.source),
        words = String(point.dataType).includes('16') ? 1 : 2;
      if (!/^\d+$/.test(String(point.source)) || offset + words > quantity)
        throw new TemplateError('点位偏移超出读取的寄存器范围');
    }
    return pipeline(
      p,
      'Modbus-TCP 采集',
      'modbus-tcp',
      `${remote}:${port}`,
      [
        {
          id: 'connection',
          type: 'modbus-client',
          name: 'Modbus 连接',
          clienttype: 'tcp',
          bufferCommands: true,
          stateLogEnabled: false,
          queueLogEnabled: false,
          failureLogEnabled: true,
          tcpHost: remote,
          tcpPort: port,
          tcpType: 'DEFAULT',
          unit_id: integer(p.unitId, '站号'),
          commandDelay: 10,
          clientTimeout: 2000,
          reconnectOnTimeout: true,
          reconnectTimeout: 5000,
          parallelUnitIdsAllowed: false,
        },
        {
          id: 'input',
          type: 'modbus-read',
          z: 'tab',
          name: '读取寄存器',
          topic: '',
          showStatusActivities: true,
          logIOActivities: false,
          showErrors: true,
          showWarnings: true,
          unitid: String(p.unitId),
          dataType: p.registerType,
          adr: String(address),
          quantity: String(quantity),
          rate: String(p.interval),
          rateUnit: 's',
          delayOnStart: true,
          startDelayTime: 1,
          server: 'connection',
          useIOFile: false,
          ioFile: '',
          useIOForPayload: false,
          emptyMsgOnFail: false,
          enableDeformedMessages: false,
          x: 160,
          y: 160,
          wires: [['decode'], []],
        },
      ],
      'registers',
    );
  },
};
