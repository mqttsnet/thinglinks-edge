import { TemplateError } from '../../types.ts';
import type { TemplateRecipe } from '../types.ts';
import { httpRequestStartScript, httpResponseScript, httpRequestErrorScript } from '../http-request.ts';
import {
  identityFields,
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
  revision: '1.0.0',
  requirements: requirements('http'),
  parameters: [
    ...identityFields,
    {
      key: 'url',
      label: '设备数据接口',
      type: 'text',
      required: true,
      default: 'http://127.0.0.1:8080/data',
    },
    intervalField,
    pointTable(),
  ],
  notes: [
    ...notes,
    '模板使用 GET 请求。设备账号、证书或访问令牌应在实例内配置，不能保存到共享模板。',
    '不接受内联账号密码的 URL；返回非 2xx 或无效 JSON 时停止本次上报。',
    '每次请求超时为 10 秒；上次请求未结束时跳过本轮采集，避免设备响应慢时并发堆积。',
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
        functionNode('http-start', '等待上次采集完成', httpRequestStartScript(), [['request']]),
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
          senderr: true,
          headers: [],
          x: 300,
          y: 160,
          wires: [['http-status']],
        },
        functionNode(
          'http-status',
          '检查 HTTP 响应',
          httpResponseScript(),
          [['decode']],
        ),
        functionNode('http-release-error', '释放失败请求', httpRequestErrorScript(), [['error-log']]),
      ],
      'json',
    );
    result.find((n) => n.id === 'errors')!.wires = [['http-release-error']];
    return result;
  },
};

export const httpReceiveRecipe: TemplateRecipe = {
  id: 'builtin:http-receive',
  name: 'HTTP 设备推送采集上云',
  description: '接收设备 POST JSON 数据，解析点位并异步上报 ThingLinks。',
  category: 'network',
  protocols: ['http'],
  revision: '1.0.0',
  requirements: requirements('http'),
  parameters: [
    ...identityFields,
    {
      key: 'path',
      label: '设备推送路径',
      type: 'text',
      required: true,
      default: '/devices/report',
      max: 128,
    },
    pointTable(),
  ],
  notes: [
    ...notes,
    '路径位于实例的 /red/{实例}/api 下，需配置设备可访问的入口及鉴权/TLS；本模板不改变管理端访问策略。',
    'HTTP 202 仅表示报文已解析并交给流程异步处理，不代表云端收到或落库；通过 Edge 上报指标确认交付。',
  ],
  build(p) {
    const path = String(p.path);
    if (!/^\/[a-zA-Z0-9/_-]+$/.test(path) || path.includes('//'))
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
        functionNode(
          'ack',
          '回复接收结果',
          "msg.statusCode=202; msg.payload={received:true,delivery:'asynchronous'}; return msg;",
          [['response']],
        ),
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
          "if (!msg.res || msg.res.headersSent || (msg.res._res && msg.res._res.headersSent)) return null; msg.statusCode=400; msg.payload={error:'数据格式或点位不符合配置'}; return msg;",
          [['response']],
        ),
      ],
      'json',
    );
    result.find((n) => n.id === 'decode')!.wires = [['device', 'ack']];
    result.find((n) => n.id === 'errors')!.scope = ['decode'];
    result.find((n) => n.id === 'errors')!.wires = [['error-log', 'bad-request']];
    return result;
  },
};
