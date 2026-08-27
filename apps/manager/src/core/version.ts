/**
 * 版本与升级检查。
 *
 * 放在 core 而不是 index，是为了让 http 层能直接引用而不成环
 * （index → http/app → http/version → index 会绕回来）。
 *
 * 升级检查**默认关闭**。现场大量站点没有外网（见 03 号文十三类网络场景），
 * 且工业客户对「设备自己往外连」很敏感 —— 必须显式配 `UPDATE_CHECK_URL`
 * 才会发起请求，绝不默认回连。
 */
export const VERSION = '1.0.1';

export function describe(): string {
  return `ThingLinks Edge Manager v${VERSION}`;
}

/** 语义化版本比较：a 比 b 新返回正数。只认 x.y.z，预发布后缀按「更旧」处理 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const core = v.trim().replace(/^v/i, '').split('-')[0] ?? '';
    const nums = core.split('.').map((n) => Number.parseInt(n, 10));
    return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
  };
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return (a1 ?? 0) - (b1 ?? 0);
  if (a2 !== b2) return (a2 ?? 0) - (b2 ?? 0);
  if (a3 !== b3) return (a3 ?? 0) - (b3 ?? 0);
  // 主体相同时，带预发布后缀的算旧：1.2.0-rc1 < 1.2.0
  const pre = (v: string) => (v.includes('-') ? 0 : 1);
  return pre(a) - pre(b);
}

export interface UpdateCheckResult {
  enabled: boolean;
  /** 查到的最新版本号；未查到或未启用时为空 */
  latest?: string | undefined;
  /** 该版本的发布页地址，供运维自行查看 */
  url?: string | undefined;
  /** 是否比当前版本新 */
  outdated?: boolean | undefined;
  checkedAt?: string | undefined;
  /** 查询失败的原因。**如实回报，不静默吞掉** —— 否则界面会长期显示「已是最新」 */
  error?: string | undefined;
}

/**
 * 从一个 JSON 端点解析出最新版本。
 *
 * 兼容两种形状：
 *   - GitHub Releases API：`{ tag_name, html_url }`
 *   - 自建端点：`{ version, url }`
 */
export function parseLatest(body: unknown): { latest: string; url: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const o = body as Record<string, unknown>;
  const raw = o['tag_name'] ?? o['version'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const url = o['html_url'] ?? o['url'];
  return {
    latest: raw.trim().replace(/^v/i, ''),
    url: typeof url === 'string' ? url : '',
  };
}

/**
 * 升级检查器。带缓存与超时。
 *
 * 一次失败不该让界面一直转圈，也不该被当成「已是最新」——
 * 失败原因原样带回给前端显示。
 */
export class UpdateChecker {
  private readonly url: string;
  private readonly intervalMs: number;
  private cached: UpdateCheckResult | null = null;
  private inflight: Promise<UpdateCheckResult> | null = null;

  constructor(opts: { url?: string | undefined; intervalMs?: number }) {
    // 归一化很关键：直接存 opts.url 时，传 undefined 会让下面的 `!== ''` 判为
    // **已启用**，于是去 fetch(undefined) —— 「没配置」变成「配置错了还往外连」，
    // 把「默认不联网」这条承诺破掉。空白串同理。
    this.url = String(opts.url ?? '').trim();
    this.intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000;
  }

  get enabled(): boolean {
    return this.url !== '';
  }

  async check(now = Date.now()): Promise<UpdateCheckResult> {
    if (!this.enabled) return { enabled: false };

    const fresh = this.cached?.checkedAt
      && now - Date.parse(this.cached.checkedAt) < this.intervalMs;
    if (fresh && this.cached) return this.cached;

    // 同时来多个请求时只发一次外网请求
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchOnce(now).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async fetchOnce(now: number): Promise<UpdateCheckResult> {
    const checkedAt = new Date(now).toISOString();
    try {
      // 现场网络可能是「连得上但极慢」，超时必须有，否则界面挂在这里
      const res = await fetch(this.url, {
        headers: { accept: 'application/json', 'user-agent': `thinglinks-edge/${VERSION}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.cached = { enabled: true, checkedAt, error: `检查更新失败：HTTP ${res.status}` };
        return this.cached;
      }
      const parsed = parseLatest(await res.json());
      if (!parsed) {
        this.cached = { enabled: true, checkedAt, error: '检查更新失败：响应里没有版本号' };
        return this.cached;
      }
      this.cached = {
        enabled: true,
        checkedAt,
        latest: parsed.latest,
        url: parsed.url,
        outdated: compareVersions(parsed.latest, VERSION) > 0,
      };
      return this.cached;
    } catch (e) {
      this.cached = {
        enabled: true,
        checkedAt,
        error: `检查更新失败：${(e as Error).message}`,
      };
      return this.cached;
    }
  }
}
