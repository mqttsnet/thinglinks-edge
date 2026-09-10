import type { TemplateRecipe } from '../types.ts';
import { framingScript } from '../framing.ts';
import {
  identityFields,
  hostField,
  portField,
  payloadFormat,
  pointTable,
  scalarTypes,
  binaryTypes,
  requirements,
  notes,
  integer,
  host,
  functionNode,
  pipeline,
} from './common.ts';

export const tcpRecipe: TemplateRecipe = {
  id: 'builtin:tcp',
  name: 'TCP 设备报文采集上云',
  description: '接收设备推送或连接设备，按换行/固定长度分帧，解析点位后上报。',
  category: 'network',
  protocols: ['tcp'],
  revision: '1.0.0',
  requirements: requirements('tcp'),
  parameters: [
    ...identityFields,
    {
      key: 'mode',
      label: '连接方式',
      type: 'select',
      default: 'server',
      options: [
        { label: '设备连接 Edge', value: 'server' },
        { label: 'Edge 连接设备', value: 'client' },
      ],
    },
    hostField,
    portField(15001),
    {
      key: 'framing',
      label: '分帧方式',
      type: 'select',
      default: 'newline',
      options: [
        { label: '换行符 LF / CRLF', value: 'newline' },
        { label: '固定字节长度', value: 'fixed' },
      ],
    },
    { key: 'frameLength', label: '固定帧长度（字节）', type: 'number', default: 4, min: 1, max: 65536 },
    payloadFormat,
    pointTable({ types: [...scalarTypes, ...binaryTypes] }),
  ],
  notes: [
    ...notes,
    '监听模式需为实例配置对应 TCP 端口映射。每个模板绑定一台逻辑设备；多设备报文需要增加身份解析。',
    'TCP 单帧上限 64 KiB；分帧缓冲最多保留 128 个活跃连接，空闲 60 秒清除。',
  ],
  build(p) {
    const port = integer(p.port, '端口');
    const remote = p.mode === 'client' ? host(p.host) : '';
    return pipeline(
      p,
      'TCP 采集',
      'tcp',
      remote ? `${remote}:${port}` : `:${port}`,
      [
        {
          id: 'input',
          type: 'tcp in',
          z: 'tab',
          name: '设备 TCP 数据',
          server: p.mode,
          host: remote,
          port: String(port),
          datamode: 'stream',
          datatype: 'buffer',
          newline: '',
          topic: '',
          trim: false,
          base64: false,
          tls: '',
          x: 130,
          y: 160,
          wires: [['frames']],
        },
        functionNode(
          'frames',
          'TCP 分帧',
          framingScript(p.framing as 'newline' | 'fixed', integer(p.frameLength, '帧长度')),
          [['decode']],
        ),
      ],
      String(p.format),
    );
  },
};
