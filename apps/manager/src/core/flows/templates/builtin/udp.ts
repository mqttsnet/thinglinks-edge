import type { TemplateRecipe } from '../types.ts';
import {
  identityFields,
  portField,
  payloadFormat,
  pointTable,
  scalarTypes,
  binaryTypes,
  requirements,
  notes,
  integer,
  pipeline,
} from './common.ts';

export const udpRecipe: TemplateRecipe = {
  id: 'builtin:udp',
  name: 'UDP 设备数据采集上云',
  description: '每个 UDP 数据报独立解析，支持 JSON 字段与二进制点位。',
  category: 'network',
  protocols: ['udp'],
  revision: '1.0.0',
  requirements: requirements('udp'),
  parameters: [
    ...identityFields,
    portField(15002),
    payloadFormat,
    pointTable({ types: [...scalarTypes, ...binaryTypes] }),
  ],
  notes: [...notes, '需为实例配置 UDP 端口映射；模板绑定一台逻辑设备。UDP 本身不保证送达或顺序。'],
  build(p) {
    const port = integer(p.port, '端口');
    return pipeline(
      p,
      'UDP 采集',
      'udp',
      `:${port}`,
      [
        {
          id: 'input',
          type: 'udp in',
          z: 'tab',
          name: '设备 UDP 数据',
          iface: '',
          port: String(port),
          ipv: 'udp4',
          multicast: 'false',
          group: '',
          datatype: 'buffer',
          x: 160,
          y: 160,
          wires: [['decode']],
        },
      ],
      String(p.format),
    );
  },
};
