/**
 * 云连接的运行期持有者。
 *
 * 存在的理由是**配置可以热改**：现场调接入参数时如果每次都要重启 Manager，
 * 正在跑的实例会跟着断一次，调三遍参数就断三遍。所以网关实例由这里持有，
 * 保存配置即 `apply()` 拆旧建新，进程不重启。
 *
 * 三条要点：
 *
 *   1. **启动不阻塞在连接上**。云端连不上是常态（现场先装边缘、后开通账号），
 *      `apply` 只负责把连接跑起来，不 await 它连上。等待连上是「测试连接」
 *      那个接口的事，不是启动路径的事。
 *   2. **未连接时 publish 直接抛错**，由 ingest 落进 spool。绝不能让 mqtt.js
 *      自己那个不可控的内存队列去兜 —— 断网一小时那种场景它兜不住，
 *      而且它兜住了我们的 spool 就永远是空的，续传能力等于没有。
 *   3. `connect()` 的 promise 被拒**不代表放弃**：mqtt.js 仍在按 reconnectPeriod
 *      重试。所以拒绝只记录成 lastError，不拆连接。
 */
import { CloudGateway, type GatewayState, type GatewayOptions } from './gateway.ts';
import { isTlsScheme, type TlsMode } from './tls.ts';
import type { CloudConfig } from './config-repo.ts';

/** 对外的连接状态。比 GatewayState 多两档，用来区分「没配」和「配了但关着」 */
export type CloudState = GatewayState | 'unconfigured' | 'disabled';

export interface CloudStatus {
  state: CloudState;
  /** 配置存在且启用 —— ingest 据此判断该说「未配置」还是「发送失败」 */
  configured: boolean;
  /** 不含凭据，可直接回给界面 */
  brokerUrl: string;
  deviceIdentification: string;
  clientId: string;
  cipherFlag: number;
  /** 链路是不是加密的。第一屏要能一眼看出来，别让人去反推地址的 scheme */
  secure: boolean;
  tlsMode: TlsMode;
  /** MQTT 协议版本（3/4/5）。第一屏要能看出实际是以哪一版连上的 */
  mqttVersion: 3 | 4 | 5;
  /**
   * 校验服务端证书。false 就是「只加密不认人」——
   * 状态里如实标出来，否则这个降级只在保存那一刻可见，事后没人记得
   */
  rejectUnauthorized: boolean;
  lastError: string;
  lastErrorAt: string | null;
  connectedAt: string | null;
  /** 累计成功上行条数（微批后的报文数，不是点位数） */
  published: number;
  failed: number;
}

export interface CloudRuntimeOptions {
  /** 注入用，测试时替换 mqtt.connect */
  connectFn?: GatewayOptions['connectFn'];
  /** 状态变化回调，用于打日志与记审计 */
  onStateChange?: (state: CloudState, detail: string) => void;
}

export class CloudRuntime {
  #gateway: CloudGateway | undefined;
  #config: CloudConfig | undefined;
  #opts: CloudRuntimeOptions;
  #lastError = '';
  #lastErrorAt: string | null = null;
  #connectedAt: string | null = null;
  #published = 0;
  #failed = 0;
  /** 最近一次 apply 触发的连接过程，供「测试连接」等待 */
  #connecting: Promise<void> | undefined;

  constructor(opts: CloudRuntimeOptions = {}) {
    this.#opts = opts;
  }

  /** 配置存在且启用。注意这与「已连上」是两件事 */
  get configured(): boolean {
    return this.#gateway !== undefined;
  }

  get state(): CloudState {
    if (!this.#config) return 'unconfigured';
    if (!this.#config.enabled) return 'disabled';
    return this.#gateway?.state ?? 'offline';
  }

  /**
   * 应用一份配置。传 undefined 或 enabled=false 都会拆掉现有连接。
   *
   * 不 await 连接结果 —— 见文件头第 1 点。返回的 promise 只表示「拆旧建新做完了」。
   */
  async apply(config: CloudConfig | undefined): Promise<void> {
    await this.#teardown();
    this.#config = config;
    this.#lastError = '';
    this.#lastErrorAt = null;

    if (!config || !config.enabled) {
      this.#emit(config ? 'disabled' : 'unconfigured', config ? '云对接已关闭' : '未配置云对接');
      return;
    }

    const gateway = new CloudGateway({
      brokerUrl: config.brokerUrl,
      credentials: {
        clientId: config.clientId,
        deviceIdentification: config.deviceIdentification,
        username: config.username,
        password: config.password,
      },
      cipher: config.cipher,
      tls: config.tls,
      connection: config.connection,
      protocolVersion: config.protocolVersion,
      qos: config.qos,
      ...(this.#opts.connectFn ? { connectFn: this.#opts.connectFn } : {}),
    });

    gateway.onStateChange((s) => {
      if (s === 'online') this.#connectedAt = new Date().toISOString();
      this.#emit(s, `云连接 ${s}`);
    });

    this.#gateway = gateway;
    this.#connecting = gateway.connect().catch((e: unknown) => {
      // 连不上不是致命错误：客户端仍在后台重试，这里只留痕
      this.#recordError((e as Error).message);
    });
    // 立刻消费一次拒绝，避免 Node 报 unhandled rejection
    void this.#connecting;
  }

  /**
   * 等待连接结果，用于「保存后立刻告诉用户连上没有」。
   *
   * 超时不代表失败 —— 后台还在重试，所以返回的是当前状态而不是抛错。
   */
  async waitSettled(timeoutMs = 8_000): Promise<CloudState> {
    const pending = this.#connecting;
    if (!pending) return this.state;
    // 计时器必须在竞速结束后清掉：不清的话，连接早就连上了，
    // 进程还要被这个定时器多吊住 timeoutMs 才肯退出
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        pending,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.state;
  }

  /**
   * 上行。未配置或未连上一律抛错，让调用方落 spool。
   *
   * 这里刻意不吞错、不重试：重试策略属于 spool 的补传逻辑，
   * 两处都重试会让同一条数据发两遍。
   */
  async publish(payload: unknown): Promise<void> {
    const gateway = this.#gateway;
    if (!gateway) {
      throw new Error(this.#config ? '云对接已关闭' : '云对接未配置');
    }
    try {
      await gateway.publishData(payload);
      this.#published += 1;
    } catch (e) {
      this.#failed += 1;
      this.#recordError((e as Error).message);
      throw e;
    }
  }

  status(): CloudStatus {
    const c = this.#config;
    return {
      state: this.state,
      configured: this.configured,
      brokerUrl: c?.brokerUrl ?? '',
      deviceIdentification: c?.deviceIdentification ?? '',
      clientId: c?.clientId ?? '',
      cipherFlag: c?.cipher.cipherFlag ?? 0,
      secure: c ? isTlsScheme(c.brokerUrl) : false,
      tlsMode: c?.tls.mode ?? 'system',
      mqttVersion: c?.connection.mqttVersion ?? 5,
      rejectUnauthorized: c?.tls.rejectUnauthorized ?? true,
      lastError: this.#lastError,
      lastErrorAt: this.#lastErrorAt,
      connectedAt: this.#connectedAt,
      published: this.#published,
      failed: this.#failed,
    };
  }

  async close(): Promise<void> {
    await this.#teardown();
    this.#config = undefined;
  }

  async #teardown(): Promise<void> {
    const gateway = this.#gateway;
    this.#gateway = undefined;
    this.#connecting = undefined;
    this.#connectedAt = null;
    if (gateway) await gateway.close();
  }

  #recordError(message: string): void {
    this.#lastError = message;
    this.#lastErrorAt = new Date().toISOString();
  }

  #emit(state: CloudState, detail: string): void {
    this.#opts.onStateChange?.(state, detail);
  }
}
