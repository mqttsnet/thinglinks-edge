/**
 * 已发布 ThingLinks 平台节点包的运行期信任边界。
 *
 * 通用导入只负责把 tarball 放进 NodeStore；这里在启动、安装前和每次固定包
 * registry 响应时重新读取原始字节并校验。HTTP 层只能拿到本次校验得到的
 * Buffer，不能校验一次后再从磁盘读第二次。
 */
import type { CatalogEntry, NodeCatalog } from './catalog.ts';
import {
  PLATFORM_APPROVAL_NOTE,
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
  PLATFORM_NODE_TYPES,
  type PlatformPackageTrustContract,
} from './platform-contract.ts';
import { NodePolicyError } from './policy.ts';
import { readPackage, type NodeStore, type PackageMeta } from './store.ts';

export type { PlatformPackageTrustContract } from './platform-contract.ts';

const PRODUCTION_CONTRACT: PlatformPackageTrustContract = {
  node: PLATFORM_NODE_PACKAGE,
  common: PLATFORM_COMMON_PACKAGE,
  nodeTypes: PLATFORM_NODE_TYPES,
};

export interface VerifiedPlatformPackage {
  /** 本次校验读取的原始字节；响应必须直接发送它，不能再从 NodeStore 读取。 */
  buffer: Buffer;
  meta: PackageMeta;
}

export interface VerifiedPlatformStore {
  node: VerifiedPlatformPackage;
  common: VerifiedPlatformPackage;
}

export interface PlatformRegistryVerifier {
  snapshotForRegistry(name: string, version: string):
    VerifiedPlatformPackage | undefined;
}

export function isPlatformPackageName(name: string): boolean {
  return name === PLATFORM_NODE_PACKAGE.name || name === PLATFORM_COMMON_PACKAGE.name;
}

function readPinned(
  store: NodeStore,
  pin: PlatformPackageTrustContract['node'],
  label: string,
): VerifiedPlatformPackage {
  const buffer = store.tarball(pin.name, pin.version);
  if (!buffer) {
    throw new NodePolicyError(`缺少固定${label}：${pin.name}@${pin.version}`);
  }
  const parsed = readPackage(buffer);
  if (parsed.name !== pin.name || parsed.version !== pin.version) {
    throw new NodePolicyError(
      `${label}元数据不匹配：期望 ${pin.name}@${pin.version}，实际 ${parsed.name}@${parsed.version}`,
    );
  }
  if (parsed.integrity !== pin.integrity) {
    throw new NodePolicyError(
      `${label} integrity 不匹配：${pin.name}@${pin.version}`,
    );
  }
  return {
    buffer,
    meta: { ...parsed, updatedAt: new Date().toISOString() },
  };
}

/**
 * 纯校验函数。测试可传内存 tarball 对应的夹具契约；生产服务不接受契约注入，
 * 始终走上面的固定常量。
 */
export function verifyPlatformPackageStore(
  store: NodeStore,
  contract: PlatformPackageTrustContract = PRODUCTION_CONTRACT,
): VerifiedPlatformStore {
  const node = readPinned(store, contract.node, 'Edge 平台包');
  const common = readPinned(store, contract.common, 'common 公共包');

  if (common.meta.hasNodeRedMetadata) {
    throw new NodePolicyError('common 公共包不能声明 node-red 元数据');
  }
  if (
    node.meta.types.length !== contract.nodeTypes.length
    || node.meta.types.some((type, i) => type !== contract.nodeTypes[i])
  ) {
    throw new NodePolicyError(
      `Edge 平台包节点类型不匹配：${node.meta.types.join(', ')}`,
    );
  }
  if (node.meta.dependencies[contract.common.name] !== contract.common.version) {
    throw new NodePolicyError(
      `Edge 平台包必须精确依赖 ${contract.common.name}@${contract.common.version}`,
    );
  }
  return { node, common };
}

export function ensurePlatformApproval(
  catalog: NodeCatalog,
  actor = 'system',
): CatalogEntry {
  return catalog.approve({
    module: PLATFORM_NODE_PACKAGE.name,
    version: PLATFORM_NODE_PACKAGE.version,
    note: PLATFORM_APPROVAL_NOTE,
    actor,
  });
}

export class PlatformPackageService implements PlatformRegistryVerifier {
  #store: NodeStore;
  #catalog: NodeCatalog;

  constructor(deps: { store: NodeStore; catalog: NodeCatalog }) {
    this.#store = deps.store;
    this.#catalog = deps.catalog;
  }

  /** 启动时先验包，再建立唯一的平台批准；任一失败都阻止继续启动。 */
  bootstrap(actor = 'system'): VerifiedPlatformStore {
    const verified = verifyPlatformPackageStore(this.#store);
    ensurePlatformApproval(this.#catalog, actor);
    return verified;
  }

  /** 每次平台安装紧邻运行期副作用前重验 tarball 与批准基线。 */
  verifyForInstall(): VerifiedPlatformPackage {
    const verified = verifyPlatformPackageStore(this.#store);
    const approved = this.#catalog.get(PLATFORM_NODE_PACKAGE.name);
    if (approved?.version !== PLATFORM_NODE_PACKAGE.version) {
      throw new NodePolicyError(
        `平台批准缺失：${PLATFORM_NODE_PACKAGE.name}@${PLATFORM_NODE_PACKAGE.version}`,
      );
    }
    return verified.node;
  }

  /**
   * 每次固定包响应都完整重验 Edge/common，再返回其中本次读取的同一个 Buffer。
   * 同名的其它版本不走通用源，避免把官方包名降级成可变信任边界。
   */
  snapshotForRegistry(name: string, version: string):
    VerifiedPlatformPackage | undefined {
    const selected = name === PLATFORM_NODE_PACKAGE.name
      && version === PLATFORM_NODE_PACKAGE.version
      ? 'node'
      : name === PLATFORM_COMMON_PACKAGE.name
        && version === PLATFORM_COMMON_PACKAGE.version
        ? 'common'
        : undefined;
    if (!selected) return undefined;
    return verifyPlatformPackageStore(this.#store)[selected];
  }
}
