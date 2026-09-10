import { isAbsolute } from 'node:path/posix';
import { TemplateError } from '../../types.ts';
import type { TemplateRecipe } from '../types.ts';
import { endpoint, identityFields, intervalField, notes, pipeline, pointTable, pointsOf, requirements, integer, injectNode } from './common.ts';

function fileReference(value: unknown, label: string, required = false): string {
  const text = String(value ?? '');
  if (!text && !required) return '';
  if (!isAbsolute(text) || /[\0\r\n]/.test(text) || text.includes('-----BEGIN')) throw new TemplateError(`${label}应填写实例内的绝对文件路径`);
  return text;
}
function fileList(value: unknown, label: string): string[] {
  const paths = String(value ?? '').split(/[;\r\n]/).map(path => path.trim()).filter(Boolean);
  if (paths.length > 32) throw new TemplateError(`${label}最多填写32个文件`);
  return [...new Set(paths.map(path => fileReference(path, label, true)))];
}

/** Checks the existing component's compact result contract; it performs no OPC UA I/O. */
function readMapping(points: Record<string, unknown>[]): string {
  return `try {
const expected=${JSON.stringify(points.map(point => ({nodeId:point.source,alias:point.property,type:point.dataType})))};
if(!Array.isArray(msg.payload)||msg.payload.length!==expected.length||!msg.opcua||msg.opcua.operation!=='read'||msg.opcua.total!==expected.length||msg.opcua.good!==expected.length||msg.opcua.resultDetail!=='compact')throw new Error('OPC UA 读取结果不完整');
const data={},seen=new Set();
const ranges={Int16:[-32768,32767],UInt16:[0,65535],Int32:[-2147483648,2147483647],UInt32:[0,4294967295]};
for(const row of msg.payload){
 const point=expected.find(point=>point.nodeId===row?.nodeId&&point.alias===row?.alias);
 if(!point||seen.has(point.nodeId)||row.statusCode!=='Good')throw new Error('OPC UA 点位或数据质量未确认');
 const value=row.value;
 if(point.type==='Boolean'){if(typeof value!=='boolean')throw new Error('OPC UA 布尔值类型不匹配');}
 else if(point.type==='String'){if(typeof value!=='string'||value.length>4096)throw new Error('OPC UA 文本值类型不匹配');}
 else {
  if(typeof value!=='number'||!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value)))throw new Error('OPC UA 数值类型或精度不匹配');
  const range=ranges[point.type];if(range&&(!Number.isInteger(value)||value<range[0]||value>range[1]))throw new Error('OPC UA 整数超出范围');
  if(point.type==='Float'&&(!Number.isFinite(Math.fround(value))||(value!==0&&Math.fround(value)===0)))throw new Error('OPC UA 浮点数超出范围');
 }
 seen.add(point.nodeId);data[point.alias]=value;
}
msg.payload=data;msg.quality='good';
}catch(error){node.error(error.message,msg);return null;}
`;
}

export const controlledOpcuaRecipe: TemplateRecipe = {
  id: 'builtin:opcua-controlled', name: 'OPC-UA 安全采集与控制',
  description: '配置现成 OPC UA 节点读取变量、验证证书及写入点位，按服务和属性编码换算上云。',
  category: 'industrial', protocols: ['opcua'], revision: '1.0.0', controlSupported: true,
  requirements: requirements('opcua-controlled'),
  parameters: [
    ...identityFields,
    { key: 'endpoint', label: 'OPC UA 服务地址', type: 'text', required: true, default: 'opc.tcp://127.0.0.1:4840' },
    { ...intervalField, label: '采集周期（秒）', max: 3600, description: '通过标准 Inject 节点触发读取；根据点位数量和设备响应速度选择周期。' },
    { key: 'timeoutMs', label: '请求超时（毫秒）', type: 'number', default: 8000, min: 100, max: 10000, group: 'advanced', description: '填写整数。连接、排队和请求由现成组件处理。' },
    { key: 'securityPolicy', label: '安全策略', type: 'select', default: 'None', options: [
      { label: 'None（无安全通道）', value: 'None' }, { label: 'Basic256Sha256', value: 'Basic256Sha256' },
    ] },
    { key: 'securityMode', label: '安全模式', type: 'select', default: 'None', options: [
      { label: 'None', value: 'None' }, { label: '签名', value: 'Sign' }, { label: '签名并加密', value: 'SignAndEncrypt' },
    ] },
    { key: 'applicationUri', label: '客户端应用 URI', type: 'text', default: 'urn:thinglinks:edge:opcua', max: 256, description: '必须与客户端证书中的应用 URI 一致。', group: 'advanced' },
    { key: 'certificateFile', label: '客户端证书文件', type: 'text', default: '', max: 2048, group: 'advanced', description: '实例内文件路径，不粘贴证书或私钥内容。' },
    { key: 'privateKeyFile', label: '客户端私钥文件', type: 'text', default: '', max: 2048, group: 'advanced' },
    { key: 'trustedCertificates', label: '已信任的服务器或 CA 证书', type: 'text', default: '', max: 16384, group: 'advanced', description: '已核实的证书文件绝对路径；多个文件用分号或换行分隔。安全连接至少填写一个。' },
    { key: 'revocationList', label: '证书吊销列表文件', type: 'text', default: '', max: 16384, group: 'advanced', description: '可选，实例内 CRL 文件绝对路径，多个文件用分号或换行分隔。' },
    pointTable({ sourceLabel: 'OPC UA NodeId', sourceDefault: 'ns=1;s=Temperature', types: ['Double', 'Float', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Boolean', 'String'] }),
  ],
  notes: [...notes,
    '使用 @tier0/opcua-client 0.6.0；ARM64 环境需准备匹配系统的原生组件。节点加载、设备连接与型号兼容性需要分别检查。',
    '用户名、密码和私钥口令在 Node-RED 连接节点配置；模板默认匿名，不保存或分发密码。使用账户认证时请选签名并加密。',
    '连接与读写由现成节点负责；最大排队1条。只将完整、匹配且全部 Good 的结果映射上云。',
    '写入前检查绝对租约截止时间和剩余预算；现成组件不消费绝对截止时间，交给组件后无法按该时间强制取消。结果未知不自动重写。',
    '旧 OPC UA 兼容模板保持原有采集能力，不会自动替换其已部署流程。'],
  build(p) {
    const url = endpoint(p.endpoint, ['opc.tcp:']);
    if (new URL(url).search) throw new TemplateError('OPC UA 服务地址不能包含查询参数');
    const secure = p.securityPolicy === 'Basic256Sha256';
    if ((!secure && p.securityMode !== 'None') || (secure && p.securityMode === 'None')) throw new TemplateError('OPC UA 安全策略与模式不匹配');
    if (!/^urn:[A-Za-z0-9:._-]+$/.test(String(p.applicationUri))) throw new TemplateError('客户端应用 URI 格式无效');
    const identityRequired = secure || !!p.certificateFile || !!p.privateKeyFile;
    const certificate = fileReference(p.certificateFile, '客户端证书文件', identityRequired);
    const privateKey = fileReference(p.privateKeyFile, '客户端私钥文件', identityRequired);
    const trustedCertificates = fileList(p.trustedCertificates, '信任证书');
    const revocationList = fileList(p.revocationList, '吊销列表');
    if (secure && !trustedCertificates.length) throw new TemplateError('安全连接至少需要一个已核实的信任证书');
    const timeout = integer(p.timeoutMs, '请求超时');
    const points = pointsOf(p), seen = new Set<string>();
    for (const point of points) {
      const source = String(point.source);
      if (!/^(ns=\d+;)?[isgb]=.+$/.test(source) || /[\0\r\n]/.test(source) || source.includes(';datatype=')) throw new TemplateError('OPC UA NodeId 格式无效');
      if (seen.has(source)) throw new TemplateError('同一 OPC UA NodeId 请只配置一次');
      if (['Boolean', 'String'].includes(String(point.dataType)) && (point.scale !== 1 || point.offset !== 0)) throw new TemplateError('布尔和文本点位不支持数值倍率或偏移');
      seen.add(source);
    }
    const scalarPoints = points.map(point => ({ ...point, source: point.property, dataType: point.dataType === 'Boolean' ? 'boolean' : point.dataType === 'String' ? 'string' : 'number' }));
    const flows = pipeline(p, 'OPC UA 安全采集与控制', 'opcua', url, [
      { id: 'connection', type: 'tier0-opcua-connection', name: 'OPC UA 连接', endpoint: url,
        securityPolicy: p.securityPolicy, securityMode: p.securityMode, applicationUri: p.applicationUri,
        certificate, privateKey, trustedCertificates, revocationList, user: '', requestTimeout: timeout,
        commandQueueSize: 1, reconnectInterval: 1000, maxReconnectInterval: 5000, connectivityCheckInterval: 1000 },
      injectNode('read-trigger', Number(p.interval), [['input']]),
      { id: 'input', type: 'tier0-opcua-read', z: 'tab', name: '读取 OPC UA 点位', connection: 'connection', nodeId: '',
        pointList: JSON.stringify(points.map(point => ({ nodeId: String(point.source), alias: String(point.property) }))),
        batchSize: 1, resultDetail: 'compact', outputMode: 'batch', x: 280, y: 160, wires: [['decode']] },
    ], 'json', scalarPoints);
    const decode = flows.find(node => node.id === 'decode')!;
    decode.func = readMapping(points) + String(decode.func);
    return flows;
  },
};
