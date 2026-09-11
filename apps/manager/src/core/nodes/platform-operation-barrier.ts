import type { NodeMigrationState } from '../instance/repo.ts';

export interface PlatformNodeOperationBarrier {
  reach(event: {
    instanceId: string;
    txId: string;
    phase: NodeMigrationState;
    sequence: number;
    artifact?:
      | 'settings'
      | 'package-manifest'
      | 'package-lock'
      | 'node-config'
      | 'module-config'
      | 'edge-module'
      | 'common-module';
    boundary:
      | 'after-phase-persist'
      | 'after-container-create'
      | 'after-settings-write'
      | 'after-live-backup'
      | 'after-live-rename'
      | 'after-same-image-rebuild';
  }): Promise<void>;
}

export const NOOP_PLATFORM_NODE_BARRIER: PlatformNodeOperationBarrier = Object.freeze({
  reach: async () => undefined,
});
