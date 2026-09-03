/**
 * ThingLinks 平台节点包的不可变信任根。
 *
 * 本文件故意只放字面量与类型，不能依赖存储、数据库或 HTTP 层。镜像构建、
 * 启动校验、安装预检和私有源响应都必须引用同一份值，避免各层各自配置后漂移。
 */
export const PLATFORM_NODE_PACKAGE = {
  name: '@mqttsnet/thinglinks-edge-nodes',
  version: '0.0.1',
  integrity: 'sha512-NKsIKyUHNyB+xuXNpCrOqzEYbYflEFeXqC/IgjM2/+AzktSTb7+TZFBWHoqp9FjLDX2crpoah6gn8n+Uy32AkA==',
} as const;

export const PLATFORM_COMMON_PACKAGE = {
  name: '@mqttsnet/thinglinks-node-red-common',
  version: '0.0.1',
  integrity: 'sha512-T6QN9RlBF0qbvujaAKNY81BjrcIdbqeqFkLfQsGuKHI8UY2cgad9prF8xUC5n4BbHbNJ7ftBmSBkj+IEZvTJWQ==',
} as const;

export const PLATFORM_NODE_TYPES =
  ['tl-device', 'tl-tag', 'tl-uplink'] as const;

export const LEGACY_PLATFORM_FILES = {
  'tl-common.js': 'c5283fefd45b46c61efc648260aaaf74b1ac18c607bfacbb4590fc493b483a54',
  'tl-device.js': '0d2f9c258dbc69417c27314d9b8e519d1abd943a45d12983fc195787702dd9cd',
  'tl-device.html': '480571820204d14a59f5afebd5c5e68816e0aebdfb0d279da9b9a3193bfe0c51',
  'tl-tag.js': '30e09321a4c5fa5be8ad0ef70fd362c8a6c4569e5682d75aa47aea10be288bb0',
  'tl-tag.html': '57fcceec244d3c8b91d7a10ad42b4af0a988447b284a25769f26d2600542ebaa',
  'tl-uplink.js': 'e80ff998cff8e7c834de4046012ec4069812c4c04882e5c8ba9d84d2d4cb42ec',
  'tl-uplink.html': 'd36764ed956f40e75e9831d329f8f1f7f6bfb52ba16a3711d7e0ce90ae7a0756',
} as const;

export const LEGACY_RUNTIME_EXCLUDES =
  ['tl-device.js', 'tl-tag.js', 'tl-uplink.js'] as const;

export const PLATFORM_APPROVAL_NOTE =
  'ThingLinks official platform node package' as const;

export interface PlatformPackagePin {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
}

export interface PlatformPackageTrustContract {
  readonly node: PlatformPackagePin;
  readonly common: PlatformPackagePin;
  readonly nodeTypes: readonly string[];
}
