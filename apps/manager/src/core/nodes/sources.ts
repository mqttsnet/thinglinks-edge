/**
 * 节点源清单（01 号文 5.7）。
 *
 * 搜索、取 packument、下载包体都按这张表里**启用中**的源依次尝试。
 *
 * 放在库里而不是环境变量：现场加一个内网私服是常规运维动作，
 * 不该每次都改编排文件重启。`EDGE_NPM_UPSTREAM` 只在全新安装时用作初始值。
 */
import type { Db } from '../db.ts';
import { NodePolicyError } from './policy.ts';

export interface NpmSource {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
}

interface Row {
  id: number; name: string; url: string; enabled: number;
  created_at: string; created_by: string;
}

const toSource = (r: Row): NpmSource => ({
  id: r.id, name: r.name, url: r.url, enabled: r.enabled === 1,
  createdAt: r.created_at, createdBy: r.created_by,
});

/**
 * 源地址校验。
 *
 * 只收 http/https 的**源站地址**，不带路径参数 —— 后面会往上拼
 * `/{包名}`、`/-/v1/search`，带查询串会拼出乱七八糟的 URL 而报错难懂。
 */
export function normalizeSourceUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new NodePolicyError(`源地址不是合法 URL：${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new NodePolicyError(`源地址只支持 http/https，收到 ${u.protocol}`);
  }
  if (u.search || u.hash) {
    throw new NodePolicyError('源地址不要带查询串或锚点，填源站地址即可');
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export class NpmSourceRepo {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(): NpmSource[] {
    return (this.#db.prepare('SELECT * FROM npm_source ORDER BY id').all() as Row[])
      .map(toSource);
  }

  /** 启用中的源，按加入顺序 —— 检索与下载都按这个顺序依次尝试 */
  active(): NpmSource[] {
    return this.list().filter((s) => s.enabled);
  }

  add(input: { name: string; url: string; actor: string }): NpmSource {
    const url = normalizeSourceUrl(input.url);
    const name = input.name.trim().slice(0, 60) || url;
    if (this.list().some((s) => s.url === url)) {
      throw new NodePolicyError(`源 ${url} 已存在`);
    }
    const info = this.#db.prepare(
      'INSERT INTO npm_source (name, url, created_by) VALUES (?, ?, ?)',
    ).run(name, url, input.actor);
    return this.list().find((s) => s.id === Number(info.lastInsertRowid))!;
  }

  setEnabled(id: number, enabled: boolean): boolean {
    return this.#db.prepare('UPDATE npm_source SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id).changes > 0;
  }

  remove(id: number): boolean {
    return this.#db.prepare('DELETE FROM npm_source WHERE id = ?').run(id).changes > 0;
  }

  /**
   * 全新安装时放一条默认源。
   *
   * 只在表为空时插 —— 已经有源就说明运维配过了，不该被启动逻辑覆盖回去。
   * 留空 url 表示这个部署刻意不配上游（纯离线），此时什么也不插。
   */
  seed(url: string, name = '官方公共源'): void {
    if (!url.trim() || this.list().length > 0) return;
    this.add({ name, url, actor: 'system' });
  }
}
