import type { TemplateRecipe } from '../types.ts';
import { TemplateError } from '../../types.ts';
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
  pointsOf,
} from './common.ts';

export const tcpRecipe: TemplateRecipe = {
  id: 'builtin:tcp',
  name: 'TCP 设备报文采集上云',
  description: '接收设备推送或连接设备，按换行/固定长度分帧，解析点位后上报。',
  category: 'network',
  protocols: ['tcp'],
  revision: '1.2.0',
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
    {
      ...hostField,
      required: true,
      visibleWhen: { key: 'mode', value: 'client' },
      description: '填写设备 TCP 服务的 IP 或主机名，不带协议和端口。127.0.0.1 指实例自身；外部设备应填写实例可访问的地址。',
    },
    {
      ...portField(15001),
      description: '设备连接 Edge：填写实例监听端口，并配置 TCP 入站映射；Edge 连接设备：填写远端设备的服务端口，无需新增实例入站映射。',
    },
    {
      key: 'framing',
      label: '分帧方式',
      type: 'select',
      default: 'newline',
      options: [
        { label: '换行符 LF / CRLF', value: 'newline' },
        { label: '固定字节长度', value: 'fixed' },
      ],
      description: '换行方式要求每条完整报文以 LF 或 CRLF 结束；二进制内容可能包含换行字节，应按设备协议选择固定长度。一次网络接收不等于一条设备报文。',
    },
    {
      key: 'frameLength', label: '固定帧长度（字节）', type: 'number', default: 4, min: 1, max: 65536,
      visibleWhen: { key: 'framing', value: 'fixed' },
      description: '填写每条完整报文的字节数，包含协议头尾。二进制点位偏移相对于整帧，从 0 开始。',
    },
    payloadFormat,
    pointTable({ types: [...scalarTypes, ...binaryTypes] }),
  ],
  notes: [
    ...notes,
    '连接建立不直接判设备在线，需收到并解析有效数据；监听模式只有全部连接关闭后判离线，一个连接断开不会影响仍在通信的连接。',
    '监听模式需为实例配置对应 TCP 端口映射。每个模板绑定一台逻辑设备；多设备报文需要增加身份解析。',
    'TCP 单帧上限 64 KiB；分帧缓冲最多保留 128 个活跃连接，空闲 60 秒清除。',
  ],
  build(p) {
    const port = integer(p.port, '端口');
    const remote = p.mode === 'client' ? host(p.host) : '';
    const frameLength = p.framing === 'fixed' ? integer(p.frameLength, '帧长度') : 1;
    if (p.framing === 'fixed' && p.format === 'binary') {
      for (const [index, point] of pointsOf(p).entries()) {
        const start = Number(point.source), width = String(point.dataType).includes('16') ? 2 : 4;
        if (start + width > frameLength) {
          throw new TemplateError(`点位第 ${index + 1} 行（${String(point.property)}）需要字节区间 ${start}–${start + width - 1}，当前固定帧仅有 0–${frameLength - 1}；请检查点位偏移、数据类型或帧长度`);
        }
      }
    }
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
          framingScript(p.framing as 'newline' | 'fixed', frameLength),
          [['decode']],
        ),
      ],
      String(p.format),
      pointsOf(p),
      { protocol: p.mode === 'client' ? 'tcp-client' : 'tcp-server', sourceIds: ['input'], failureWindowMs: 1000 },
    );
  },
};
