import { GITHUB_REPOSITORY } from './config.ts';

export interface ProductRelease {
  tag: string; name: string; body: string; publishedAt: string; url: string;
  prerelease: boolean; truncated: boolean;
}
export interface ProductReleaseResult {
  state: 'ready' | 'error' | 'disabled';
  releases: ProductRelease[];
  checkedAt: string;
  message?: string;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('response too large');
  }
  if (!response.body) throw new Error('empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('response too large');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Explicitly requested public releases, with bounded reads and shared caching. No startup polling. */
export class GithubReleases {
  private readonly repository: string;
  private readonly fetcher: typeof fetch;
  private cached: ProductReleaseResult | undefined;
  private expiresAt = 0;
  private inflight: Promise<ProductReleaseResult> | undefined;
  constructor(repository: string, fetcher: typeof fetch = fetch) {
    if (repository && !GITHUB_REPOSITORY.test(repository)) throw new Error('无效的 GitHub 仓库配置');
    this.repository = repository;
    this.fetcher = fetcher;
  }

  async read(): Promise<ProductReleaseResult> {
    if (!this.repository) return { state: 'disabled', releases: [], checkedAt: '', message: '当前部署未配置 GitHub 仓库。' };
    if (this.cached && Date.now() < this.expiresAt) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchOnce().then(result => {
      this.cached = result;
      this.expiresAt = Date.now() + (result.state === 'ready' ? 600_000 : 30_000);
      return result;
    }).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async fetchOnce(): Promise<ProductReleaseResult> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/releases?per_page=10`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'edge-product-releases', 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(8000), redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { state: 'error', releases: [], checkedAt, message: response.status === 403 || response.status === 429
          ? 'GitHub 暂时限制了请求，请稍后再试。' : '暂时无法读取 GitHub 更新记录，请稍后重试或访问项目发布页。' };
      }
      const body = await readJson(response);
      if (!Array.isArray(body)) throw new Error('unexpected releases');
      const releases: ProductRelease[] = [];
      for (const item of body) {
        if (!item || typeof item !== 'object' || item.draft === true || typeof item.tag_name !== 'string' || !item.tag_name.trim()) continue;
        const tag = item.tag_name.slice(0, 200);
        const notes = typeof item.body === 'string' ? item.body : '';
        const publishedAt = typeof item.published_at === 'string' && Number.isFinite(Date.parse(item.published_at)) ? item.published_at : '';
        releases.push({ tag, name: typeof item.name === 'string' ? item.name.slice(0, 300) : tag,
          body: notes.slice(0, 65_536), truncated: notes.length > 65_536, publishedAt,
          prerelease: item.prerelease === true,
          url: `https://github.com/${this.repository}/releases/tag/${encodeURIComponent(tag)}` });
        if (releases.length === 10) break;
      }
      return { state: 'ready', releases, checkedAt };
    } catch {
      return { state: 'error', releases: [], checkedAt, message: '暂时无法读取 GitHub 更新记录，请检查网络后重试，或访问项目发布页。' };
    }
  }
}
