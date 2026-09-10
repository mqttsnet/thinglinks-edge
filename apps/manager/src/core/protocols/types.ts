/** Exact package identity and runtime node types used by a protocol or recipe. */
export interface NodeRequirement {
  module: string;
  version: string;
  nodeTypes: string[];
}

export interface ProtocolDefinition {
  id: string;
  name: string;
  category: 'network' | 'industrial' | 'building' | 'power';
  status: 'available' | 'blocked' | 'extension';
  description: string;
  notes: string[];
  requirements: NodeRequirement[];
  builtinNodeTypes: string[];
}

export interface ProtocolPackageFacts {
  packagePresent: boolean;
  /** This package archive only; dependency closure and native/runtime readiness are separate. */
  integrityValid: boolean;
  approval: 'exact' | 'unrestricted' | 'other' | 'missing';
}

export interface ProtocolPackageStatus extends NodeRequirement, ProtocolPackageFacts {
  /** Admin API observation, not a claim about unloaded files in node_modules. */
  installedVersion: string | null;
  installation: 'not-inspected' | 'not-observed' | 'version-mismatch' | 'installed';
  loaded: boolean | null;
  missingNodeTypes: string[];
}

export interface ProtocolComponentStatus extends ProtocolDefinition {
  packages: ProtocolPackageStatus[];
  /** Runtime readiness only. null means no instance has been inspected. */
  ready: boolean | null;
  blockers: string[];
}
