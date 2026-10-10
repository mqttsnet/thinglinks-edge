import type { TemplateRecipe } from '../types.ts';
import {
  identityFields,
  silenceTimeoutField,
  pointsOf,
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
  revision: '1.3.0',
  requirements: requirements('udp'),
  parameters: [
    ...identityFields,
    silenceTimeoutField,
    {
      ...portField(15002),
      label: '实例接收端口',
      description: '填写实例内接收设备数据的 UDP 端口，并配置相同协议的 UDP 入站映射。设备向映射后的 Edge 地址和端口发送数据。',
    },
    {
      ...payloadFormat,
      description: '每个 UDP 数据报必须携带一条完整 JSON 对象或二进制报文，无需添加换行。多个数据报不会拼接；二进制点位填写从 0 开始的字节偏移。',
    },
    pointTable({ types: [...scalarTypes, ...binaryTypes] }),
  ],
  notes: [
    ...notes,
    'UDP 没有连接状态，默认不按缺少报文判离线；可在高级设置明确约定有效数据静默时限。停止流程后通过观察租约到期更新状态。',
    '需为实例配置 UDP 端口映射；模板绑定一台逻辑设备。UDP 本身不保证送达或顺序，也不会自动补发。',
    '来源 IP 和端口只用于网络来源信息，不会自动校验或解析设备身份；不要让多台设备共用此模板的上报入口，需多设备接入时先增加身份解析与校验。',
  ],
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
      pointsOf(p),
      { protocol: 'push', sourceIds: [], failureWindowMs: 1000, silenceTimeoutMs: Number(p.silenceTimeout ?? 0) * 1000 },
    );
  },
};
