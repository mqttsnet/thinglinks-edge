import { TemplateError, type FlowNode } from '../types.ts';
import type { TemplateParameter, NodeRequirement } from './types.ts';
import { controlWriteScript } from './control-codec.ts';
import { framingScript } from './framing.ts';
import { managedOpcuaControlNodes } from './control-opcua-managed.ts';
import {
  bindingPollScript,
  nextCommandScript,
  claimCommandScript,
  commandResultScript,
  networkAckScript,
  resultDeliveredScript,
  type ControlBindingConfig,
} from './control-runtime.ts';
import { functionNode, injectNode, endpoint, host, integer } from './builtin/common.ts';

export const OPCUA_CONTROL_UNAVAILABLE_REASON = '当前受管实例支持采集；控制待独立受控执行节点交付';
export const MODBUS_CONTROL_UNAVAILABLE_REASON = 'Modbus 采集正常；当前组件断网超时后仍可能在恢复时迟到执行写入，内置模板暂不支持云端控制。已保存的旧控制流程不会自动修改，需明确关闭控制并重新部署。';

export function controlParameters(protocol: string, supported = !['opcua', 'modbus-tcp'].includes(protocol)): TemplateParameter[] {
  const unavailableReason = protocol === 'modbus-tcp' ? MODBUS_CONTROL_UNAVAILABLE_REASON
    : protocol === 'opcua' ? OPCUA_CONTROL_UNAVAILABLE_REASON : '当前模板暂不提供云端控制';
  const visibleWhen = { key: 'downlinkEnabled', value: true };
  const fields: TemplateParameter[] = [
    {
      key: 'downlinkEnabled',
      label: '允许云端命令控制设备',
      type: 'boolean',
      default: false,
      group: 'commands',
      ...(!supported ? { disabledReason: unavailableReason }
        : { description: '仅执行下表明确映射的单参数命令；设备执行确认后回传标准回执，超时不重放写操作。' }),
    },
    {
      key: 'commands',
      ...(!supported ? { disabledReason: unavailableReason } : {}),
      label: '命令到设备点位映射',
      type: 'table',
      default: [],
      min: 0,
      max: 64,
      group: 'commands',
      visibleWhen,
      columns: [
        { key: 'cmd', label: '云端命令编码', type: 'text', required: true, max: 128 },
        { key: 'param', label: '命令参数编码', type: 'text', required: true, max: 128 },
        { key: 'property', label: '目标点位属性编码', type: 'text', required: true, max: 64 },
      ],
    },
  ];
  if (protocol === 'http')
    fields.push({
      key: 'commandUrl',
      label: '设备控制接口',
      type: 'text',
      default: 'http://127.0.0.1:8080/control',
      group: 'commands',
      visibleWhen,
      description: 'POST JSON；请求字段来自点位的源字段，接口须以 HTTP 200 和确认字段=true 表示执行成功。',
    });
  if (protocol === 'tcp' || protocol === 'udp')
    fields.push(
      {
        key: 'commandHost',
        label: '设备控制地址',
        type: 'text',
        default: '127.0.0.1',
        group: 'commands',
        visibleWhen,
      },
      {
        key: 'commandPort',
        label: '设备控制端口',
        type: 'number',
        default: protocol === 'tcp' ? 15011 : 15012,
        min: 1,
        max: 65535,
        group: 'commands',
        visibleWhen,
        description:
          '适用于支持 JSON 请求/应答的设备。请求为 requestId/cmd/params，应答须回传同一 requestId 和确认字段=true。',
      },
    );
  if (protocol === 'udp')
    fields.push({
      key: 'commandReplyPort',
      label: 'Edge 命令应答端口',
      type: 'number',
      default: 15013,
      min: 1,
      max: 65535,
      group: 'advanced',
      visibleWhen,
      description: 'UDP 以此端口发送并接收应答；需映射该 UDP 端口，与数据采集端口区分。',
    });
  if (['tcp', 'udp', 'http'].includes(protocol))
    fields.push({
      key: 'commandAckField',
      label: '设备执行确认字段',
      type: 'text',
      default: 'ok',
      max: 64,
      group: 'advanced',
      visibleWhen,
      description: '应答 JSON 中此字段严格等于布尔 true 才报告成功；发送完成或 HTTP 202 不代表设备执行成功。',
    });
  return fields;
}

function requestNode(id: string, name: string, wires: string[][]): FlowNode {
  return {
    id,
    type: 'http request',
    z: 'tab',
    name,
    method: 'use',
    ret: 'obj',
    paytoqs: 'ignore',
    url: '',
    tls: '',
    persist: false,
    proxy: '',
    authType: '',
    senderr: true,
    headers: [],
    x: 350,
    y: 550,
    wires,
  };
}
export function controlRequirements(protocol: string, requirements: NodeRequirement[]): NodeRequirement[] {
  return requirements.map((r) => ({
    ...r,
    nodeTypes: [
      ...new Set([
        ...r.nodeTypes,
        ...(protocol === 'modbus-tcp' && r.module === 'node-red-contrib-modbus' ? ['modbus-flex-write'] : []),
        ...(protocol === 's7' && r.module === 'node-red-contrib-s7' ? ['s7 out'] : []),
        ...(protocol === 'opcua' && r.module === '@tier0/opcua-client' ? ['tier0-opcua-write'] : []),
      ]),
    ],
  }));
}

/** Add the optional reverse path without coupling recipe builders to HTTP or cloud runtime services. */
export function attachControlFlow(
  protocol: string,
  p: Record<string, unknown>,
  base: FlowNode[],
): FlowNode[] {
  if (p.downlinkEnabled !== true) return base;
  if (protocol === 'modbus-tcp') throw new TemplateError(MODBUS_CONTROL_UNAVAILABLE_REASON);
  if (protocol === 'opcua' && !base.some(node => node.id === 'connection' && node.type === 'tier0-opcua-connection'))
    throw new TemplateError(OPCUA_CONTROL_UNAVAILABLE_REASON);
  const mappings = p.commands as ControlBindingConfig['commands'];
  if (!mappings.length) throw new TemplateError('启用设备控制时至少配置一个命令映射');
  const points = p.points as Record<string, unknown>[];
  const seen = new Set<string>();
  for (const mapping of mappings) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(mapping.cmd) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(mapping.param) ||
      ['__proto__', 'constructor', 'prototype'].includes(mapping.param)
    )
      throw new TemplateError('命令或参数编码格式无效');
    if (seen.has(mapping.cmd)) throw new TemplateError('同一命令只能配置一个单参数映射');
    seen.add(mapping.cmd);
    const point = points.find((row) => row.property === mapping.property);
    if (!point) throw new TemplateError('控制映射必须选择已配置的点位属性');
    if (point.scale === 0) throw new TemplateError('控制点位倍率不能为 0');
  }
  if ((protocol === 'tcp' || protocol === 'udp') && p.format !== 'json')
    throw new TemplateError('网络通用控制模板只支持 JSON 请求/应答；私有二进制控制需要专门适配');
  if (protocol === 'udp' && p.commandReplyPort === p.port)
    throw new TemplateError('命令应答端口不能与采集端口相同');
  const ack = String(p.commandAckField ?? 'ok');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(ack)) throw new TemplateError('命令确认字段格式无效');
  const binding = { nodeId: String(p.nodeId), serviceCode: String(p.serviceCode), commands: mappings };
  const options = {
    nodeId: binding.nodeId,
    serviceCode: binding.serviceCode,
    points,
    mappings,
    ...(protocol === 'modbus-tcp' ? { unitId: Number(p.unitId), address: Number(p.address) } : {}),
    ...(protocol === 'http' ? { commandUrl: endpoint(p.commandUrl, ['http:', 'https:']) } : {}),
  };
  const nodes: FlowNode[] = [
    injectNode('control-poll', 1, [['control-bind']]),
    functionNode('control-bind', '登记命令映射与轮询', bindingPollScript(binding), [
      ['control-bind-http'],
      ['control-result-http'],
      protocol === 'tcp' ? ['control-writer'] : [],
    ]),
    requestNode('control-bind-http', '登记控制映射', [['control-next']]),
    functionNode('control-next', '获取当前设备命令', nextCommandScript(binding), [['control-next-http']]),
    requestNode('control-next-http', '领取一个命令', [['control-claim']]),
    functionNode('control-claim', '保存命令租约', claimCommandScript(), [['control-encode']]),
    functionNode(
      'control-encode',
      '命令参数转换',
      `${protocol === 'opcua' ? 'const leaseDeadline=msg.payload&&msg.payload.command&&msg.payload.command.leaseDeadline;' : ''}
const output=(function(msg){${controlWriteScript(protocol, options)}})(msg);
if(!output)return null;
${protocol === 'opcua' ? "if(!Number.isSafeInteger(leaseDeadline)||leaseDeadline<=Date.now()){output._tleWriteAttempted=false;node.error('OPC UA 命令租约无效或已过期',output);return null;}output._tleCommand.leaseDeadline=leaseDeadline;" : ''}
output._tleWriteAttempted=${protocol === 'opcua' ? 'false' : 'true'};
${protocol === 'http' ? 'output.requestTimeout=10000;' : ''}
${protocol === 'tcp' ? 'output.reset=true;output.payload += "\\n";' : ''}
return output;`,
      [['control-writer']],
    ),
    functionNode('control-result', '确认设备执行结果', commandResultScript(protocol, true, ack), [
      ['control-result-http'],
    ]),
    functionNode('control-failed', '记录设备执行失败', commandResultScript(protocol, false), [
      ['control-result-http'],
    ]),
    requestNode('control-result-http', '提交执行回执', [['control-delivered']]),
    functionNode('control-delivered', '检查回执提交', resultDeliveredScript(), []),
    {
      id: 'control-errors',
      type: 'catch',
      z: 'tab',
      name: '控制链路异常',
      scope: [
        'control-bind',
        'control-bind-http',
        'control-next',
        'control-next-http',
        'control-claim',
        'control-encode',
        'control-writer',
        'control-result',
        'control-frames',
      ],
      uncaught: false,
      x: 160,
      y: 850,
      wires: [['control-failed', 'error-log']],
    },
  ];
  const connection = base.find((n) => n.id === 'connection');
  if (protocol === 'modbus-tcp')
    nodes.push(
      {
        ...structuredClone(connection!),
        id: 'control-connection',
        name: 'Modbus 控制专用连接',
        bufferCommands: false,
        parallelUnitIdsAllowed: false,
        showErrors: true,
      },
      {
        id: 'control-writer',
        type: 'modbus-flex-write',
        z: 'tab',
        name: '写入 Modbus 寄存器',
        server: 'control-connection',
        keepMsgProperties: true,
        emptyMsgOnFail: false,
        showErrors: true,
        showWarnings: true,
        showStatusActivities: true,
        x: 700,
        y: 550,
        wires: [['control-result'], []],
      },
    );
  else if (protocol === 'opcua') {
    nodes.find(node => node.id === 'control-encode')!.wires = [['control-opcua-prepare']];
    nodes.find(node => node.id === 'control-errors')!.wires = [['control-opcua-error', 'error-log']];
    (nodes.find(node => node.id === 'control-errors')!.scope as string[]).push('control-opcua-prepare', 'control-opcua-result');
    nodes.push(...managedOpcuaControlNodes(connection!.id, points, Number(p.timeoutMs)));
  } else if (protocol === 's7') {
    nodes.push(
      {
        id: 'control-writer',
        type: 's7 out',
        z: 'tab',
        name: '写入 S7 变量',
        endpoint: connection!.id,
        variable: '',
        x: 700,
        y: 550,
        wires: [],
      },
      {
        id: 'control-complete',
        type: 'complete',
        z: 'tab',
        name: '等待 PLC 写入确认',
        scope: ['control-writer'],
        uncaught: false,
        x: 900,
        y: 550,
        wires: [['control-result']],
      },
    );
  } else if (protocol === 'http')
    nodes.push(requestNode('control-writer', '请求设备控制接口', [['control-result']]));
  else if (protocol === 'tcp') {
    const remote = host(p.commandHost),
      port = integer(p.commandPort, '设备控制端口');
    nodes.push(
      {
        id: 'control-writer',
        type: 'tcp request',
        z: 'tab',
        name: 'JSON 设备命令',
        server: remote,
        port: String(port),
        out: 'sit',
        ret: 'buffer',
        splitc: '0',
        newline: '',
        trim: false,
        tls: '',
        x: 700,
        y: 550,
        wires: [['control-frames']],
      },
      functionNode('control-frames', '命令应答分帧', framingScript('newline', 1), [['control-result']]),
    );
    nodes.find((n) => n.id === 'control-result')!.func = networkAckScript('tcp', ack);
  } else if (protocol === 'udp') {
    const remote = host(p.commandHost),
      port = integer(p.commandPort, '设备控制端口'),
      reply = integer(p.commandReplyPort, '命令应答端口');
    nodes.push(
      {
        id: 'control-replies',
        type: 'udp in',
        z: 'tab',
        name: '接收命令应答',
        port: String(reply),
        iface: '',
        ipv: 'udp4',
        multicast: 'false',
        group: '',
        datatype: 'buffer',
        x: 700,
        y: 660,
        wires: [['control-result']],
      },
      {
        id: 'control-writer',
        type: 'udp out',
        z: 'tab',
        name: 'JSON 设备命令',
        addr: remote,
        port: String(port),
        outport: String(reply),
        iface: '',
        ipv: 'udp4',
        multicast: 'false',
        base64: false,
        x: 700,
        y: 550,
        wires: [],
      },
    );
    nodes.find((n) => n.id === 'control-result')!.func = networkAckScript('udp', ack);
  }
  const ids = new Set(nodes.map((n) => n.id));
  nodes.find((n) => n.id === 'control-errors')!.scope = (
    nodes.find((n) => n.id === 'control-errors')!.scope as string[]
  ).filter((id) => ids.has(id));
  for (let i = 0; i < nodes.length; i++)
    if (nodes[i]!.z === 'tab' && nodes[i]!.type !== 'catch') {
      nodes[i]!.x = 140 + (i % 5) * 240;
      nodes[i]!.y = 520 + Math.floor(i / 5) * 110;
    }
  return [...base, ...nodes];
}
