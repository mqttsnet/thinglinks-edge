/**
 * 已批准节点清单（01 号文 5.7「节点白名单」）。
 *
 * 这张表是**闸门本身**，不是一份参考资料：实例 settings.js 里的 allowList
 * 完全由它生成（见 policy.ts），改一条就要重写实例配置并重启实例。
 * 所以每条都记了谁批的、什么时候 —— 出事时要能查到人。
 *
 * 与 NodeStore 的分工：
 *
 *   · 这里回答「**允许**装什么」
 *   · NodeStore 回答「**有**什么可装」
 *
 * 两者不必一致，而且不一致是常态：
 *   - 批了但库里没有 → 有外网的现场照样能从上游装（如果配了上游）
 *   - 库里有但没批   → 多半是某个已批准节点的依赖，本来就不该单独批
 */
import type { Db } from '../db.ts';
import { assertModuleName, assertVersionRange, NodePolicyError, type ApprovedModule }
  from './policy.ts';
import {
  PLATFORM_APPROVAL_NOTE,
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
} from './platform-contract.ts';

export interface CatalogEntry extends ApprovedModule {
  note: string;
  approvedBy: string;
  approvedAt: string;
}

interface Row {
  module: string;
  version: string;
  note: string;
  approved_by: string;
  approved_at: string;
}

const toEntry = (r: Row): CatalogEntry => ({
  module: r.module,
  version: r.version === '' ? undefined : r.version,
  note: r.note,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
});

export class NodeCatalog {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(): CatalogEntry[] {
    const rows = this.#db
      .prepare('SELECT * FROM node_catalog ORDER BY module')
      .all() as Row[];
    return rows.map(toEntry);
  }

  get(module: string): CatalogEntry | undefined {
    const r = this.#db
      .prepare('SELECT * FROM node_catalog WHERE module = ?')
      .get(module) as Row | undefined;
    return r ? toEntry(r) : undefined;
  }

  /** 批准一个包名。已存在则更新版本范围与备注 */
  approve(input: {
    module: string; version?: string | undefined; note?: string | undefined; actor: string;
  }): CatalogEntry {
    assertModuleName(input.module);
    const version = input.version?.trim() ?? '';
    if (version !== '') assertVersionRange(version);
    if (!input.actor) throw new NodePolicyError('缺少审批人');
    if (input.module === PLATFORM_COMMON_PACKAGE.name) {
      throw new NodePolicyError(
        `common 公共包禁止批准：${PLATFORM_COMMON_PACKAGE.name}`,
      );
    }

    const current = this.get(input.module);
    if (
      current?.module === PLATFORM_NODE_PACKAGE.name
      && current.version === PLATFORM_NODE_PACKAGE.version
    ) {
      if (version === PLATFORM_NODE_PACKAGE.version && input.note === PLATFORM_APPROVAL_NOTE) {
        return current;
      }
      throw new NodePolicyError(
        `固定平台批准禁止更新：${PLATFORM_NODE_PACKAGE.name}@${PLATFORM_NODE_PACKAGE.version}`,
      );
    }

    this.#db.prepare(
      `INSERT INTO node_catalog (module, version, note, approved_by, approved_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(module) DO UPDATE SET
         version = excluded.version,
         note = excluded.note,
         approved_by = excluded.approved_by,
         approved_at = excluded.approved_at`,
    ).run(input.module, version, (input.note ?? '').slice(0, 500), input.actor);

    return this.get(input.module)!;
  }

  /** 撤销批准。返回是否真的删掉了一条 */
  revoke(module: string): boolean {
    const current = this.get(module);
    if (
      current?.module === PLATFORM_NODE_PACKAGE.name
      && current.version === PLATFORM_NODE_PACKAGE.version
    ) {
      throw new NodePolicyError(
        `固定平台批准禁止撤销：${PLATFORM_NODE_PACKAGE.name}@${PLATFORM_NODE_PACKAGE.version}`,
      );
    }
    return this.#db.prepare('DELETE FROM node_catalog WHERE module = ?')
      .run(module).changes > 0;
  }

  /** 生成 policy 用的形状 */
  approved(): ApprovedModule[] {
    return this.list()
      .filter((e) => e.module !== PLATFORM_COMMON_PACKAGE.name)
      .map((e) => ({ module: e.module, version: e.version }));
  }

  names(): Set<string> {
    return new Set(this.list()
      .filter((e) => e.module !== PLATFORM_COMMON_PACKAGE.name)
      .map((e) => e.module));
  }
}
