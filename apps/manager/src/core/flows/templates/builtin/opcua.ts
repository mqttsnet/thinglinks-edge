import { TemplateError, type FlowNode } from '../../types.ts';
import { OPCUA_CONTROL_UNAVAILABLE_REASON } from '../control-flow.ts';
import type { TemplateRecipe } from '../types.ts';
import { opcuaTransformScript } from '../transform.ts';
import {
  identityFields,
  intervalField,
  pointTable,
  requirements,
  notes,
  endpoint,
  injectNode,
  pipeline,
  pointsOf,
} from './common.ts';

export const opcuaRecipe: TemplateRecipe = {
  id: 'builtin:opcua',
  name: 'OPC-UA 变量采集上云',
  description: '按变量表读取或订阅 OPC UA 标量，并映射到 ThingLinks 属性。',
  category: 'industrial',
  protocols: ['opcua'],
  revision: '1.0.0',
  requirements: requirements('opcua'),
  parameters: [
    ...identityFields,
    {
      key: 'endpoint',
      label: 'OPC UA 服务地址',
      type: 'text',
      required: true,
      default: 'opc.tcp://127.0.0.1:4840',
    },
    {
      key: 'action',
      label: '采集方式',
      type: 'select',
      default: 'read',
      options: [
        { label: '定时读取', value: 'read' },
        { label: '订阅变化', value: 'subscribe' },
      ],
    },
    intervalField,
    pointTable({
      sourceLabel: 'OPC UA NodeId',
      sourceDefault: 'ns=2;s=Temperature',
      types: ['Double', 'Float', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Boolean', 'String'],
    }),
  ],
  notes: [
    ...notes,
    OPCUA_CONTROL_UNAVAILABLE_REASON,
    '初始模板使用匿名连接；现场有账号或安全策略时，请在实例编辑器的 OPC UA 连接节点配置凭据和证书，再开始采集。',
    '每个变量独立上报；64 位整数、复杂结构和数组需另行配置转换，模板不会将其静默转成低精度数值。',
  ],
  build(p) {
    const url = endpoint(p.endpoint, ['opc.tcp:']);
    const points = pointsOf(p);
    for (const point of points)
      if (!/^(ns=\d+;)?[isgb]=.+$/.test(String(point.source)))
        throw new TemplateError('OPC UA NodeId 格式应为 ns=2;s=Temperature 等标准形式');
    const inputs: FlowNode[] = [
      {
        id: 'connection',
        type: 'OpcUa-Endpoint',
        name: 'OPC UA 连接',
        endpoint: url,
        secpol: 'None',
        secmode: 'None',
        none: true,
        login: false,
        usercert: false,
      },
      injectNode('poll', p.action === 'subscribe' ? 0 : Number(p.interval), [
        points.map((_, i) => `item-${i}`),
      ]),
      ...points.map((point, i) => ({
        id: `item-${i}`,
        type: 'OpcUa-Item',
        z: 'tab',
        name: String(point.property),
        item: String(point.source),
        datatype: String(point.dataType),
        value: '',
        x: 290,
        y: 80 + i * 55,
        wires: [['input']],
      })),
      {
        id: 'input',
        type: 'OpcUa-Client',
        z: 'tab',
        name: 'OPC UA 采集',
        endpoint: 'connection',
        action: p.action,
        time: Number(p.interval),
        timeUnit: 's',
        deadbandtype: 'a',
        deadbandvalue: 0,
        certificate: 'n',
        localfile: '',
        localkeyfile: '',
        securitymode: 'None',
        securitypolicy: 'None',
        useTransport: false,
        maxChunkCount: 1,
        maxMessageSize: 8192,
        receiveBufferSize: 8192,
        sendBufferSize: 8192,
        setstatusandtime: true,
        keepsessionalive: true,
        x: 440,
        y: 160,
        wires: [['decode'], ['opc-status'], []],
      },
      {
        id: 'opc-status',
        type: 'debug',
        z: 'tab',
        name: 'OPC UA 连接状态',
        active: true,
        tosidebar: true,
        console: false,
        complete: 'status',
        targetType: 'msg',
        x: 600,
        y: 260,
        wires: [],
      },
    ];
    if (p.action === 'subscribe') inputs.find((n) => n.id === 'poll')!.repeat = '';
    const result = pipeline(p, 'OPC UA 采集', 'opcua', url, inputs, 'json');
    result.find((n) => n.id === 'decode')!.func = opcuaTransformScript(
      String(p.nodeId),
      String(p.serviceCode),
      points,
    );
    return result;
  },
};
