/**
 * 虚拟网关 —— Edge 以一台「网关设备」的身份接入 ThingLinks 云。
 *
 * 现场设备是它的**子设备**，沿用网关的产品与物模型，不另建产品。
 * 所有上行都必须从这里出去：只有这样断网缓存、微批聚合与信封签名才有唯一落点。
 * 用户 flow 里直接用 `mqtt out` 发云端会绕过这三件事，是明确禁止的做法。
 *
 * 连接凭据全部由平台分配，**Edge 一律原样使用、不自行拼接**：
 * `clientId` 尤其如此 —— 它是 `<雪花ID>@<租户ID>`，那个雪花段与设备标识
 * 不是同一个值（同一台网关实测差 1），自己拼会连不上。
 */
import mqtt, { type MqttClient, type IClientOptions } from 'mqtt';
import {
  buildEnvelope, parseEnvelopeFull, nextMid, type CipherParams, type CipherFlag,
} from './envelope.ts';
import {
  fetchModel, type ModelQueryRequest, type ModelQueryResponse, type ProductModel,
} from './model-client.ts';
import { tlsConnectOptions, DEFAULT_TLS, type TlsConfig } from './tls.ts';
import {
  buildAddPayload, buildUpdatePayload, buildDeletePayload, chunk, summarizeAddResult,
  DEFAULT_BATCH_SIZE, TopoError,
  type SubDeviceInfo, type SubDeviceStatus, type TopoAddResult, type TopoOperationResult,
} from './topo.ts';

export interface GatewayCredentials {
  /** 平台分配，形如 `2130020836696064@1`。不要自己拼 */
  clientId: string;
  /** 网关设备标识，topic 里用的就是它 */
  deviceIdentification: string;
  username: string;
  password: string;
}

export interface GatewayOptions {
  /** 形如 `mqtts://broker.thinglinks.mqttsnet.com:11884`，加不加密由地址的 scheme 决定 */
  brokerUrl: string;
  credentials: GatewayCredentials;
  cipher: CipherParams;
  /**
   * TLS 材料。缺省即 `system` 模式：走系统根证书、严格校验。
   * 地址是明文协议时整块被忽略（`tlsConnectOptions` 自己判断），
   * 不在这里再判一次 —— 同一条规则两处实现必然漂移。
   */
  tls?: TlsConfig;
  /** topic 首段的协议版本，当前 `v1` */
  protocolVersion?: string;
  /** 上行 QoS，默认 1。云侧不做去重，QoS2 的代价通常不值得 */
  qos?: 0 | 1 | 2;
  /** 重连间隔上限，毫秒 */
  reconnectPeriodMs?: number;
  connectTimeoutMs?: number;
  /** 请求-响应等待上限，默认 15 秒 */
  requestTimeoutMs?: number;
  /** 注入用，测试时替换 mqtt.connect */
  connectFn?: (url: string, opts: IClientOptions) => MqttClient;
}

export type GatewayState = 'offline' | 'connecting' | 'online';

/** 云侧 topic 表（`07-云平台对接契约.md` 第 2 节） */
export function topicsFor(version: string, deviceId: string) {
  const base = `/${version}/devices/${deviceId}`;
  return {
    datas: `${base}/datas`,
    command: `${base}/command`,
    commandResponse: `${base}/commandResponse`,
    topoAdd: `${base}/topo/add`,
    topoAddResponse: `${base}/topo/addResponse`,
    topoUpdate: `${base}/topo/update`,
    topoUpdateResponse: `${base}/topo/updateResponse`,
    topoDelete: `${base}/topo/delete`,
    topoDeleteResponse: `${base}/topo/deleteResponse`,
    topoQuery: `${base}/topo/query`,
    modelQuery: `${base}/model/query`,
    modelQueryResponse: `${base}/model/queryResponse`,
  } as const;
}

export interface DownlinkCommand {
  topic: string;
  /** 已验签并解密后的业务报文 */
  body: unknown;
}

export class CloudGateway {
  readonly topics: ReturnType<typeof topicsFor>;
  #client: MqttClient | undefined;
  #state: GatewayState = 'offline';
  #o: GatewayOptions;
  #handlers = new Set<(cmd: DownlinkCommand) => void>();
  #stateHandlers = new Set<(s: GatewayState) => void>();
  /** mid → 等待中的请求。云侧响应沿用源 mid，这是关联的唯一依据 */
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(options: GatewayOptions) {
    this.#o = options;
    this.topics = topicsFor(options.protocolVersion ?? 'v1', options.credentials.deviceIdentification);
  }

  get state(): GatewayState { return this.#state; }
  get connected(): boolean { return this.#state === 'online'; }

  onCommand(fn: (cmd: DownlinkCommand) => void): () => void {
    this.#handlers.add(fn);
    return () => this.#handlers.delete(fn);
  }

  onStateChange(fn: (s: GatewayState) => void): () => void {
    this.#stateHandlers.add(fn);
    return () => this.#stateHandlers.delete(fn);
  }

  #setState(s: GatewayState): void {
    if (this.#state === s) return;
    this.#state = s;
    for (const fn of this.#stateHandlers) fn(s);
  }

  /** 建立连接。返回的 Promise 在首次连上时兑现；之后的断线由客户端自动重连 */
  async connect(): Promise<void> {
    const { brokerUrl, credentials, connectFn } = this.#o;
    this.#setState('connecting');

    const opts: IClientOptions = {
      clientId: credentials.clientId,
      username: credentials.username,
      password: credentials.password,
      // 干净会话：离线期间的补发由我们自己的 spool 负责，不依赖 broker 的会话保持 ——
      // 会话队列有上限且不可控，断网一小时那种场景靠它兜不住
      clean: true,
      protocolVersion: 5,
      reconnectPeriod: this.#o.reconnectPeriodMs ?? 5_000,
      connectTimeout: this.#o.connectTimeoutMs ?? 15_000,
      resubscribe: true,
      // ca/cert/key/rejectUnauthorized/servername 原样交给 node:tls。
      // 明文地址下这里是空对象，一个 TLS 字段都不会塞进去
      ...tlsConnectOptions(this.#o.tls ?? DEFAULT_TLS, brokerUrl),
    };

    const client = (connectFn ?? mqtt.connect)(brokerUrl, opts);
    this.#client = client;

    client.on('connect', () => {
      this.#setState('online');
      // 响应 topic 必须在连上时就订阅：请求发出后再订阅会漏掉先到的响应
      client.subscribe(
        [this.topics.command, this.topics.topoAddResponse,
         this.topics.topoUpdateResponse, this.topics.topoDeleteResponse,
         this.topics.modelQueryResponse],
        { qos: this.#o.qos ?? 1 },
      );
    });
    client.on('reconnect', () => this.#setState('connecting'));
    client.on('close', () => this.#setState('offline'));
    client.on('offline', () => this.#setState('offline'));
    client.on('message', (topic, payload) => this.#dispatch(topic, payload));

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve(); };
      const onError = (e: Error) => { cleanup(); reject(e); };
      const cleanup = () => {
        client.removeListener('connect', onConnect);
        client.removeListener('error', onError);
      };
      client.once('connect', onConnect);
      client.once('error', onError);
    });
  }

  #dispatch(topic: string, payload: Buffer): void {
    let head: { mid: number };
    let body: unknown;
    try {
      ({ head, body } = parseEnvelopeFull(payload, this.#o.cipher));
    } catch (e) {
      // 拆不开就丢弃并留痕：静默吞掉会让「云端发了但现场没反应」无从查起
      console.warn(`[gateway] 下行报文丢弃 topic=${topic}：${(e as Error).message}`);
      return;
    }

    // 先看是不是某次请求的响应；是就兑现，不再当成命令派发
    const waiter = this.#pending.get(head.mid);
    if (waiter) {
      this.#pending.delete(head.mid);
      clearTimeout(waiter.timer);
      waiter.resolve(body);
      return;
    }

    for (const fn of this.#handlers) fn({ topic, body });
  }

  /**
   * 发一条请求并等对应响应。
   *
   * 靠 `mid` 关联 —— 云侧 `buildResponse(src, ...)` 沿用源 mid。
   * 超时必须报错而不是静默挂着：注册失败要能被上层看见并重试。
   */
  async #request<T>(topic: string, payload: unknown): Promise<T> {
    const client = this.#client;
    if (!client || this.#state !== 'online') {
      throw new Error(`网关未连接（当前 ${this.#state}），请求未发出`);
    }
    const mid = nextMid();
    const envelope = buildEnvelope(payload, this.#o.cipher, { mid });
    const timeoutMs = this.#o.requestTimeoutMs ?? 15_000;

    const waited = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(mid);
        reject(new Error(`请求超时（${timeoutMs}ms）：${topic} mid=${mid}`));
      }, timeoutMs);
      this.#pending.set(mid, { resolve: resolve as (v: unknown) => void, reject, timer });
    });

    await client.publishAsync(topic, JSON.stringify(envelope), { qos: this.#o.qos ?? 1 });
    return waited;
  }

  /**
   * 注册子设备。
   *
   * 分批是**边缘侧**的选择（MQTT 单包大小、失败重试粒度），云侧对条数没有限制。
   * 逐批串行：并发发出去时，某一批失败很难对上是哪几台设备。
   */
  async registerSubDevices(
    devices: SubDeviceInfo[],
    opts: { batchSize?: number } = {},
  ): Promise<{ ok: boolean; succeeded: number; failed: { nodeId: string; statusDesc: string }[] }> {
    const gatewayId = this.#o.credentials.deviceIdentification;
    const batches = chunk(devices, opts.batchSize ?? DEFAULT_BATCH_SIZE);
    let succeeded = 0;
    const failed: { nodeId: string; statusDesc: string }[] = [];

    for (const batch of batches) {
      const payload = buildAddPayload(gatewayId, batch);
      const result = await this.#request<TopoAddResult>(this.topics.topoAdd, payload);
      const summary = summarizeAddResult(result);
      succeeded += summary.succeeded;
      // 顶层成功不代表每台都成功 —— 逐条结果在 data[] 里，按下标对回原始设备
      for (const f of summary.failed) {
        failed.push({ nodeId: batch[f.index]?.nodeId ?? `#${f.index}`, statusDesc: f.statusDesc });
      }
      if (result.statusCode !== 0 && (result.data ?? []).length === 0) {
        // 整批被拒（网关不存在或 nodeType 不是 GATEWAY），逐条结果都没有
        throw new TopoError(`整批注册被拒：${result.statusDesc}`);
      }
    }
    return { ok: failed.length === 0, succeeded, failed };
  }

  /** 上报子设备在线状态 */
  updateSubDeviceStatus(
    statuses: { deviceId: string; status: SubDeviceStatus }[],
  ): Promise<TopoOperationResult> {
    const gatewayId = this.#o.credentials.deviceIdentification;
    return this.#request<TopoOperationResult>(
      this.topics.topoUpdate, buildUpdatePayload(gatewayId, statuses));
  }

  /**
   * 拉取完整物模型，自动续拉分片。
   *
   * 两个标识都缺省 = 「给我我自己的物模型」，边缘最常用的形态。
   * 分片按服务切，收一片合一片，不需要拼接缓冲区（11 号文 3.3）。
   */
  fetchModel(req: ModelQueryRequest = {}): Promise<{ model: ProductModel; versionNo?: string; pages: number }> {
    return fetchModel(
      (r) => this.#request<ModelQueryResponse>(this.topics.modelQuery, r),
      req,
    );
  }

  /** 删除子设备 */
  deleteSubDevices(deviceIds: string[]): Promise<TopoOperationResult> {
    const gatewayId = this.#o.credentials.deviceIdentification;
    return this.#request<TopoOperationResult>(
      this.topics.topoDelete, buildDeletePayload(gatewayId, deviceIds));
  }

  /** 发布一条已包信封的报文。未连接时抛错，由上层决定是入 spool 还是丢弃 */
  async publish(topic: string, payload: unknown, opts: { cipherFlag?: CipherFlag } = {}): Promise<void> {
    const client = this.#client;
    if (!client || this.#state !== 'online') {
      throw new Error(`网关未连接（当前 ${this.#state}），报文未发出`);
    }
    const cipher = opts.cipherFlag === undefined
      ? this.#o.cipher
      : { ...this.#o.cipher, cipherFlag: opts.cipherFlag };
    const envelope = buildEnvelope(payload, cipher);
    await client.publishAsync(topic, JSON.stringify(envelope), { qos: this.#o.qos ?? 1 });
  }

  /** 上报点位数据 */
  publishData(payload: unknown): Promise<void> {
    return this.publish(this.topics.datas, payload);
  }

  async close(): Promise<void> {
    // 挂着的请求要显式失败，否则调用方会一直 await 到永远
    for (const [, w] of this.#pending) {
      clearTimeout(w.timer);
      w.reject(new Error('网关已关闭'));
    }
    this.#pending.clear();
    const client = this.#client;
    this.#client = undefined;
    this.#setState('offline');
    if (client) await client.endAsync(true);
  }
}
