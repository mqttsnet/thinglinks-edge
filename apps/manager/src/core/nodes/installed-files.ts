/** Host-side verification of the exact platform packages installed under one /data bind. */
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { assertValidId } from '../instance/container-spec.ts';
import {
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
  PLATFORM_NODE_TYPES,
} from './platform-contract.ts';

type JsonRecord = Record<string, unknown>;

export interface VerifyInstalledPlatformFilesOptions {
  instanceDataRoot: string;
  instanceId: string;
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
}

export class InstalledPlatformFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstalledPlatformFilesError';
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new InstalledPlatformFilesError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function verifiedPath(parent: string, path: string, label: string): Promise<string> {
  let actual: string;
  try {
    actual = await realpath(path);
  } catch {
    throw new InstalledPlatformFilesError(`${label} path is missing`);
  }
  if (!contains(parent, actual)) {
    throw new InstalledPlatformFilesError(`${label} path escapes containment`);
  }
  return actual;
}

async function jsonFile(
  parent: string,
  path: string,
  label: string,
  readFile: VerifyInstalledPlatformFilesOptions['readFile'],
): Promise<JsonRecord> {
  const safePath = await verifiedPath(parent, path, label);
  try {
    return record(JSON.parse(await readFile(safePath, 'utf8')), label);
  } catch (error) {
    if (error instanceof InstalledPlatformFilesError) throw error;
    throw new InstalledPlatformFilesError(`${label} is not valid JSON`);
  }
}

function dependencies(value: JsonRecord, label: string): JsonRecord {
  return record(value['dependencies'], `${label} dependencies`);
}

function expectExact(value: unknown, expected: string, label: string): void {
  if (value !== expected) {
    throw new InstalledPlatformFilesError(`${label} version is not exact`);
  }
}

export async function verifyInstalledPlatformFiles(
  options: VerifyInstalledPlatformFilesOptions,
): Promise<void> {
  assertValidId(options.instanceId);
  let root: string;
  try {
    root = await realpath(resolve(options.instanceDataRoot));
  } catch {
    throw new InstalledPlatformFilesError('Manager instance data root path is missing');
  }
  const candidate = resolve(root, options.instanceId);
  if (!contains(root, candidate) || candidate === root) {
    throw new InstalledPlatformFilesError('instance path escapes Manager data root');
  }
  const instance = await verifiedPath(root, candidate, 'instance');

  const edgeRelative = join('node_modules', ...PLATFORM_NODE_PACKAGE.name.split('/'));
  const commonRelative = join('node_modules', ...PLATFORM_COMMON_PACKAGE.name.split('/'));
  const rootPackage = await jsonFile(
    instance, join(instance, 'package.json'), 'root package', options.readFile,
  );
  const lock = await jsonFile(
    instance, join(instance, 'package-lock.json'), 'root lock', options.readFile,
  );
  const edge = await jsonFile(
    instance, join(instance, edgeRelative, 'package.json'), 'edge manifest', options.readFile,
  );
  const common = await jsonFile(
    instance, join(instance, commonRelative, 'package.json'), 'common manifest', options.readFile,
  );

  expectExact(
    dependencies(rootPackage, 'root package')[PLATFORM_NODE_PACKAGE.name],
    PLATFORM_NODE_PACKAGE.version,
    'root package Edge',
  );

  const packages = record(lock['packages'], 'root lock packages');
  const lockRoot = record(packages[''], 'root lock project');
  expectExact(
    dependencies(lockRoot, 'root lock project')[PLATFORM_NODE_PACKAGE.name],
    PLATFORM_NODE_PACKAGE.version,
    'root lock Edge',
  );
  const edgeLock = record(packages[edgeRelative], 'edge lock entry');
  const commonLock = record(packages[commonRelative], 'common lock entry');
  expectExact(edgeLock['version'], PLATFORM_NODE_PACKAGE.version, 'edge lock');
  if (edgeLock['integrity'] !== PLATFORM_NODE_PACKAGE.integrity) {
    throw new InstalledPlatformFilesError('edge lock integrity mismatch');
  }
  expectExact(
    dependencies(edgeLock, 'edge lock')[PLATFORM_COMMON_PACKAGE.name],
    PLATFORM_COMMON_PACKAGE.version,
    'edge lock common',
  );
  expectExact(commonLock['version'], PLATFORM_COMMON_PACKAGE.version, 'common lock');
  if (commonLock['integrity'] !== PLATFORM_COMMON_PACKAGE.integrity) {
    throw new InstalledPlatformFilesError('common lock integrity mismatch');
  }

  expectExact(edge['name'], PLATFORM_NODE_PACKAGE.name, 'edge manifest name');
  expectExact(edge['version'], PLATFORM_NODE_PACKAGE.version, 'edge manifest');
  expectExact(
    dependencies(edge, 'edge manifest')[PLATFORM_COMMON_PACKAGE.name],
    PLATFORM_COMMON_PACKAGE.version,
    'edge common',
  );
  const nodeRed = record(edge['node-red'], 'edge node-red metadata');
  const nodes = record(nodeRed['nodes'], 'edge node registrations');
  const registrations = Object.entries(nodes).sort(([a], [b]) => a.localeCompare(b));
  const expectedRegistrations = PLATFORM_NODE_TYPES
    .map((type) => [type, `${type}.js`] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (
    registrations.length !== expectedRegistrations.length
    || registrations.some(([type, file], index) => (
      type !== expectedRegistrations[index]?.[0] || file !== expectedRegistrations[index]?.[1]
    ))
  ) {
    throw new InstalledPlatformFilesError('edge node type registrations are not exact');
  }

  expectExact(common['name'], PLATFORM_COMMON_PACKAGE.name, 'common manifest name');
  expectExact(common['version'], PLATFORM_COMMON_PACKAGE.version, 'common manifest');
  if (Object.prototype.hasOwnProperty.call(common, 'node-red')) {
    throw new InstalledPlatformFilesError('common manifest must not declare node-red metadata');
  }
}
