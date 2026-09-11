/**
 * 预置节点包的导入（01 号文 5.7「离线场景下节点可用」）。
 *
 * 种子目录是**放 .tgz 的普通目录**，不是什么特殊格式 —— 现场运维拿 U 盘
 * 拷一个 `npm pack` 出来的文件进去就能用。这一点是刻意的：
 * 离线现场最缺的就是「再想个办法把这个包弄进去」的办法。
 *
 * 每次启动扫一遍，已在库里的跳过。做成幂等而不是「装过就打个标记」——
 * 标记文件会和实际内容漂移，而重算一遍的代价只是读几十个文件。
 *
 * **导入不等于批准**。种子包进了库只是「有得装」，能不能装还要看批准清单
 * （见 catalog.ts）。合在一起会让「随包发的节点」自动获得执行权限，
 * 那等于把白名单的钥匙交给打包的人。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readPackage, type NodeStore } from './store.ts';

export interface SeedResult {
  /** 本次真正导入的，形如 `name@version` */
  imported: string[];
  /** 库里已有、跳过的 */
  skipped: string[];
  /** 读不了或不是合法包的，附原因 */
  failed: Array<{ file: string; error: string }>;
}

/**
 * 把一个目录里的 .tgz 全部导入库。
 *
 * 目录不存在**不是错误**：绝大多数部署没有预置包，为此打一行错误日志
 * 只会训练出「启动日志里的红字不用看」的习惯。
 */
export function seedFromDir(store: NodeStore, dir: string): SeedResult {
  const out: SeedResult = { imported: [], skipped: [], failed: [] };
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return out;

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.tgz')) continue;
    try {
      const buf = readFileSync(join(dir, file));
      /*
       * 先解析、确认库里没有，再落盘。直接 add 也对（同版本覆盖是幂等的），
       * 但那样每次重启都要重写一遍全部种子包 —— 跑在 SD 卡上的盒子经不起。
       */
      const meta = readPackage(buf);
      if (store.has(meta.name, meta.version)) {
        out.skipped.push(`${meta.name}@${meta.version}`);
        continue;
      }
      store.add(buf);
      out.imported.push(`${meta.name}@${meta.version}`);
    } catch (e) {
      out.failed.push({ file, error: (e as Error).message });
    }
  }
  return out;
}

/** 渲染成一行启动日志。什么都没发生时返回空串，调用方据此不打日志 */
export function describeSeed(dir: string, r: SeedResult): string {
  const parts: string[] = [];
  if (r.imported.length > 0) parts.push(`导入 ${r.imported.length}`);
  if (r.skipped.length > 0) parts.push(`已有 ${r.skipped.length}`);
  if (r.failed.length > 0) parts.push(`失败 ${r.failed.length}`);
  if (parts.length === 0) return '';
  const detail = r.failed.length > 0
    ? `；失败：${r.failed.map((f) => `${f.file}（${f.error}）`).join('、')}`
    : '';
  return `预置节点包 ${dir}：${parts.join(' · ')}${detail}`;
}
