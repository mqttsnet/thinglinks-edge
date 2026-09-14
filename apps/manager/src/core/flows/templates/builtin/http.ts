import { presenceHttpTransport } from '../presence-http-transport.ts';
import { TemplateError } from '../../types.ts';
import type { TemplateRecipe } from '../types.ts';
import { httpRequestStartScript, httpResponseScript, httpRequestErrorScript } from '../http-request.ts';
import {
  identityFields,
  silenceTimeoutField,
  pointsOf,
  intervalField,
  pointTable,
  requirements,
  notes,
  endpoint,
  injectNode,
  functionNode,
  pipeline,
} from './common.ts';

export const httpPollRecipe: TemplateRecipe = {
  id: 'builtin:http-poll',
  name: 'HTTP / HTTPS 定时采集上云',
  description: '定时读取设备 JSON 接口，映射点位后上报。HTTPS 使用系统证书校验。',
  category: 'network',
  protocols: ['http'],
  revision: '1.2.0',
  previewParameters: { url: 'http://192.0.2.10:8080/data' },
  requirements: requirements('http'),
  parameters: [
    ...identityFields,
    {
      key: 'url',
      label: '设备数据接口',
      type: 'text',
      required: true,
      default: '',
      description: '填写设备 JSON 数据接口，模板使用 GET 请求。127.0.0.1 指实例自身，连接外部设备时请填写实例可访问的真实地址。',
    },
    { ...intervalField, description: '上一请求未结束时跳过本轮触发，避免慢响应造成请求积压；填写的采集周期不会被自动修改。' },
    { key: 'requestTimeout', label: '读取超时（毫秒）', type: 'number', default: 10000, min: 100, max: 60000, group: 'advanced',
      description: '原生 HTTP 请求的完整等待上限，包括连接与响应。建议根据设备响应时间设置，默认 10000 毫秒。' },
    { ...pointTable(), description: '填写响应 JSON 的源字段路径，例如 temperature 或 data.temperature；目标填写物模型属性编码，并按实际数据选择数值、布尔或文本。' },
  ],
  notes: [
    ...notes,
    '有效 JSON 采样维持在线；明确连接失败或连续超时后上报离线。HTTP 401/500 或无效业务数据不直接视为设备断线。',
    '模板使用 GET 请求。设备账号、证书或访问令牌应在实例内配置，不能保存到共享模板。',
    '不接受内联账号密码的 URL；返回非 2xx 或无效 JSON 时停止本次上报。',
    '默认读取超时为 10000 毫秒，可在高级设置中调整；上次请求未结束时跳过触发，成功、错误和超时结束后均释放下一轮采集。',
    'HTTPS 默认执行证书校验。私有 CA 或自签名证书应在实例内配置可信 CA 或原生 TLS 节点，不自动关闭证书校验。',
  ],
  build(p) {
    const url = endpoint(p.url, ['http:', 'https:']);
    const result = pipeline(
      p,
      'HTTP 定时采集',
      'http',
      url,
      [
        injectNode('poll', Number(p.interval), [['http-start']]),
        functionNode('http-start', '等待上次采集完成', httpRequestStartScript(p.requestTimeout === undefined ? 10000 : p.requestTimeout as number), [['request']]),
        {
          id: 'request',
          type: 'http request',
          z: 'tab',
          name: '读取设备数据',
          method: 'GET',
          ret: 'obj',
          paytoqs: 'ignore',
          url,
          tls: '',
          persist: false,
          proxy: '',
          authType: '',
          senderr: false,
          headers: [],
          x: 300,
          y: 160,
          wires: [['http-status']],
        },
        functionNode(
          'http-status',
          '检查 HTTP 响应',
          httpResponseScript(true),
          [['decode'], ['presence']],
        ),
        functionNode('http-release-error', '释放失败请求', httpRequestErrorScript(true), [['error-log'], ['presence']]),
      ],
      'json',
      pointsOf(p),
      { protocol: 'http-poll', sourceIds: [], failureWindowMs: Math.ceil(Math.max(10000, Number(p.interval) * 3000 + Number(p.requestTimeout ?? 10000))) },
    );
    // The native request's normal error output retains ETIMEDOUT across locales.
    // Catch is log-only: releasing here would race and discard that original output.
    result.find((n) => n.id === 'errors')!.scope = (result.find(n => n.id === 'errors')!.scope as string[]).filter(id => id !== 'request');
    result.find((n) => n.id === 'errors')!.wires = [['http-release-error']];
    result.push({ id: 'http-native-errors', type: 'catch', z: 'tab', name: 'HTTP 原生请求异常', scope: ['request'], uncaught: false, x: 180, y: 400, wires: [['error-log']] });
    return result;
  },
};

export const httpReceiveRecipe: TemplateRecipe = {
  id: 'builtin:http-receive',
  name: 'HTTP 设备推送采集上云',
  description: '接收设备 POST JSON 数据，解析点位并异步上报 ThingLinks。',
  category: 'network',
  protocols: ['http'],
  revision: '1.2.0',
  requirements: requirements('http'),
  parameters: [
    ...identityFields,
    silenceTimeoutField,
    {
      key: 'path',
      label: '设备推送路径',
      type: 'text',
      required: true,
      default: '/devices/report',
      max: 128,
      description: '仅填写业务路径，不填写主机或端口；实际接收地址由实例 httpNodeRoot 与此路径拼接，请使用部署时配置的受保护入口。',
    },
    { ...pointTable(), description: '设备应 POST JSON 对象并发送 Content-Type: application/json；源字段支持 data.temperature 等嵌套路径。' },
  ],
  notes: [
    ...notes,
    '实际接收路径为 httpNodeRoot + 推送路径。Edge 当前生成的 httpNodeRoot 为 {basePath}/red/{实例}/api/；部署有前缀时必须一并保留。',
    '请通过配置好的受保护设备入口访问，并在入口配置设备鉴权与 TLS。Manager 现有反代要求 Edge 登录及实例操作权限，不能直接当作匿名设备入口。',
    '实例内部 1880 端口和独立编辑器端口都不是可直接发布的设备地址；模板不会开放端口、绕过鉴权或修改证书策略。',
    '同一实例中相同 POST 路径不能重复部署；修改推送路径后也需要同步修改设备端地址。',
    'HTTP 202 表示 Manager 已接受有效采集数据，不代表云端收到或落库；启动、续租或平台未接受时返回 503，可稍后重试。重试可能重复采样，上行不承诺恰好一次。',
    '默认不按推送静默判离线；仅当设备固定周期发送时，在高级设置明确约定静默时限。',
  ],
  build(p) {
    const path = p.path;
    if (typeof path !== 'string' || path.length > 128 || !/^\/[a-zA-Z0-9/_-]+$/.test(path) || path.includes('//'))
      throw new TemplateError('推送路径必须以 / 开头，仅含字母、数字、横线、下划线和目录分隔符');
    const result = pipeline(
      p,
      'HTTP 推送采集',
      'http',
      path,
      [
        {
          id: 'input',
          type: 'http in',
          z: 'tab',
          name: '设备数据推送',
          url: path,
          method: 'post',
          upload: false,
          swaggerDoc: '',
          x: 130,
          y: 160,
          wires: [['decode']],
        },
        {
          id: 'response',
          type: 'http response',
          z: 'tab',
          name: '设备响应',
          statusCode: '',
          headers: {},
          x: 770,
          y: 250,
          wires: [],
        },
        functionNode(
          'bad-request',
          '回复数据错误',
          "if (!msg.res || msg.res.headersSent || (msg.res._res && msg.res._res.headersSent)) return null; return {req:msg.req,res:msg.res,statusCode:400,headers:{'content-type':'application/json'},payload:{error:'数据格式或点位不符合配置'}};",
          [['response']],
        ),
      ],
      'json',
      pointsOf(p),
      { protocol: 'push', sourceIds: [], httpResponse: true, silenceTimeoutMs: Number(p.silenceTimeout ?? 0) * 1000, failureWindowMs: 1000 },
    );
    result.splice(result.findIndex(n => n.id === 'uplink'), 1);
    result.find(n => n.id === 'device')!.wires = [['presence-uplink-request']];
    result.push(...presenceHttpTransport());
    result.find((n) => n.id === 'errors')!.scope = ['decode'];
    result.find((n) => n.id === 'errors')!.wires = [['error-log', 'bad-request']];
    return result;
  },
};
