import { appendFlows } from '../../merge.ts';
import { presenceFlow } from '../presence-flow.ts';
import { TemplateError, type FlowNode } from '../../types.ts';
import { OPCUA_CONTROL_UNAVAILABLE_REASON } from '../control-flow.ts';
import type { TemplateRecipe } from '../types.ts';
import { opcuaTransformScript } from '../transform.ts';
import { normalizeOpcuaPoints, opcuaEndpoint, opcuaPointTable } from '../industrial-address.ts';
import {
  identityFields,
  intervalField,
  pointTable,
  requirements,
  notes,
  injectNode,
  pipeline,
  pointsOf,
  integer,
} from './common.ts';

export const opcuaRecipe: TemplateRecipe = {
  id: 'builtin:opcua',
  name: 'OPC-UA 变量采集上云',
  description: '适合匿名、无加密的兼容采集，支持定时读取或订阅变化；需要证书、账号或控制时请选择安全采集与控制模板。',
  category: 'industrial',
  protocols: ['opcua'],
  revision: '1.2.0',
  previewParameters: { endpoint: 'opc.tcp://192.0.2.10:4840/UA/Server' },
  requirements: requirements('opcua'),
  parameters: [
    ...identityFields,
    {
      key: 'endpoint',
      label: 'OPC UA 服务地址',
      type: 'text',
      required: true,
      default: '',
      description: '填写实例可访问的完整 opc.tcp:// 地址，包含服务器实际端口和路径。127.0.0.1 指实例自身；服务地址不是浏览变量时看到的 NodeId。',
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
    { ...intervalField, description: '定时读取时为读取周期；订阅时为订阅发布间隔，实际变化通知还取决于服务器采样及限额。' },
    { key: 'healthInterval', label: '订阅健康读取周期（秒）', type: 'number', default: 60, min: 0, max: 86400, group: 'advanced', visibleWhen: { key: 'action', value: 'subscribe' },
      description: '订阅期间用独立客户端周期读取同一组点位，需要额外 1 个 OPC UA 会话。默认 60 秒，填写整数；0 表示关闭。服务器会话额度不足时可改用定时读取，关闭后云连接恢复需等待新的订阅值通知。' },
    opcuaPointTable(pointTable({
      sourceLabel: 'OPC UA NodeId',
      sourceDefault: 'ns=2;s=Temperature',
      types: ['Double', 'Float', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Boolean', 'String'],
    })),
  ],
  notes: [
    ...notes,
    '只用有效变量采样确认在线；会话断开或持续重连后上报离线。订阅默认额外建立 1 个独立读取会话，每 60 秒读取相同点位；变化订阅不重建，静止值也能通过新的 Good 读取恢复云端状态。',
    '订阅和健康读取各自报告连接状态，只要任一来源有有效采样且未失联就保持在线。健康读取失败不会拖掉正常订阅。关闭健康读取后，云连接恢复需等待新的订阅值通知；服务器会话额度不足时可选定时读取。',
    OPCUA_CONTROL_UNAVAILABLE_REASON,
    '本兼容模板保持匿名、None 安全策略。服务器需要用户名、证书、签名或加密时请选择 OPC-UA 安全采集与控制模板，再在其连接节点配置凭据；不要为迁就模板降低服务器策略。',
    'NodeId 数字、命名空间和 GUID 的等价表示会统一；字符串标识的大小写与空格保留。请从服务器复制 NodeId，不用浏览名称代替。',
    '每个变量独立上报；64 位整数、复杂结构和数组需另行配置转换，模板不会将其静默转成低精度数值。',
  ],
  build(p) {
    const url = opcuaEndpoint(p.endpoint);
    const points = normalizeOpcuaPoints(pointsOf(p));
    p.points = points;
    const inputs: FlowNode[] = [
      {
        id: 'connection', z: 'tab',
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
        wires: [['decode'], ['opc-status', 'presence-source'], []],
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
    const healthInterval = integer(p.healthInterval ?? 60, '订阅健康读取周期');
    if (healthInterval < 0 || healthInterval > 86400) throw new TemplateError('订阅健康读取周期应为 0–86400 秒');
    if (p.action === 'subscribe') inputs.find((n) => n.id === 'poll')!.repeat = '';
    const withHealth = p.action === 'subscribe' && healthInterval > 0;
    if (withHealth) {
      inputs.push(
        { ...injectNode('health-poll', healthInterval, [points.map((_, i) => `health-item-${i}`)]), name: '定期验证订阅设备通信', y: 720 },
        ...points.map((_, i) => ({ ...structuredClone(inputs.find(node => node.id === `item-${i}`)!), id: `health-item-${i}`, y: 720 + i * 55, wires: [['health-input']] })),
        { ...structuredClone(inputs.find(node => node.id === 'input')!), id: 'health-input', name: '订阅健康读取', action: 'read', y: 720, wires: [['health-decode'], ['opc-status', 'health-presence-source'], []] },
      );
    }
    let result = pipeline(p, 'OPC UA 采集', 'opcua', url, inputs, 'json', points,
      { protocol: 'opcua', sourceIds: ['input'], failureWindowMs: Math.ceil(Math.max(10000, Number(p.interval) * 3000)) });
    result.find((n) => n.id === 'decode')!.func = opcuaTransformScript(
      String(p.nodeId),
      String(p.serviceCode),
      points,
    );
    if (withHealth) {
      const decode = structuredClone(result.find(node => node.id === 'decode')!);
      result.push({ ...decode, id: 'health-decode', name: '健康读取与物模型映射', y: 800, wires: [['health-presence']] });
      (result.find(node => node.id === 'errors')!.scope as string[]).push('health-decode');
      const observer = presenceFlow({ nodeId: String(p.nodeId), serviceCode: String(p.serviceCode), protocol: 'opcua', sourceIds: ['health-input'], failureWindowMs: 10000 });
      for (const node of observer) { node.y = Number(node.y ?? 0) + 600; if (node.id === 'presence') node.name = '健康读取状态观察'; }
      result = appendFlows(result, observer, id => `health-${id}`);
    }
    return result;
  },
};
