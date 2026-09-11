import type { FlowNode } from '../types.ts';
import type { NodeRequirement } from '../../protocols/types.ts';
export type { NodeRequirement } from '../../protocols/types.ts';

/** Declarative data only. Recipe builders never execute parameter expressions. */
export interface TemplateParameter {
  /** Current capability restriction; an enabled legacy boolean may only be turned off. */
  disabledReason?: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'boolean' | 'table';
  required?: boolean;
  default?: unknown;
  description?: string;
  min?: number;
  max?: number;
  options?: { label: string; value: string | number }[];
  columns?: TemplateParameter[];
  group?: 'device' | 'cloud' | 'points' | 'commands' | 'advanced';
  visibleWhen?: { key: string; value: string | number | boolean };
}

export interface TemplateRecipe {
  id: string;
  name: string;
  description: string;
  category: string;
  protocols: string[];
  revision: string;
  requirements: NodeRequirement[];
  parameters: TemplateParameter[];
  notes: string[];
  /** Explicitly enable a separately delivered controller while preserving legacy recipe limits. */
  controlSupported?: boolean;
  build(parameters: Record<string, unknown>): FlowNode[];
}
