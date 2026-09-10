/** Deployment planning has no persistence or HTTP reply dependencies. The caller holds the instance gate. */
import {
  AdminApiError, getFlows, getFlowSnapshot, getInstalledNodeSets, getInstalledTypes,
  setFlows, setFlowSnapshot,
  type AdminTarget, type FetchLike, type InstalledNodeSet,
} from './admin-client.ts';
import { checkCompatibility, type CompatResult } from './compat.ts';
import { appendFlows } from './merge.ts';
import { parseFlows, summarize } from './parse.ts';
import { scanInlineSecrets } from './scan.ts';
import { TemplateError, type FlowNode, type TemplateSummary } from './types.ts';
import type { NodeRequirement } from './templates/types.ts';
import { listenerConflicts } from './listeners.ts';

export interface FlowDeploymentInput {
  flows: FlowNode[];
  builtin?: boolean;
  mode?: unknown;
  requirements?: readonly NodeRequirement[];
  expectedRevision?: unknown;
}
export interface PreparedFlowDeployment extends TemplateSummary {
  mode: 'append' | 'replace';
  compat: CompatResult;
  dependencyIssues: string[];
  deployable: boolean;
  warnings: string[];
  revision?: string;
  replacedNodeCount: number | null;
  resultNodeCount: number;
  note: string;
  /** Internal deployment body; HTTP responses omit it. */
  flowsToDeploy: FlowNode[];
}

function strictDependencies(types: string[], requirements: readonly NodeRequirement[], sets: InstalledNodeSet[]) {
  const loaded = sets.filter((set) => set.enabled && set.enabledKnown !== false && !set.err);
  const compat = checkCompatibility(types.filter((type) => type !== 'group'), loaded.flatMap((set) => set.types));
  const issues = compat.missing.map((type) => `节点 ${type} 未安装、未启用或加载失败，请先准备所需组件`);
  for (const type of types) {
    const owners = sets.filter((set) => set.types.includes(type));
    if (owners.length > 1) {
      issues.push(`节点 ${type} 存在多个组件或版本，需先解决节点冲突`);
    }
  }
  for (const requirement of requirements) {
    const moduleSets = sets.filter((set) => set.module === requirement.module);
    if (!moduleSets.length) {
      issues.push(`缺少组件 ${requirement.module}@${requirement.version}，请先安装批准版本`);
      continue;
    }
    if (moduleSets.some((set) => set.version !== requirement.version)) {
      issues.push(`组件 ${requirement.module} 版本未确认或不匹配，需要 ${requirement.version}`);
    }
    for (const type of requirement.nodeTypes) {
      if (!moduleSets.some((set) => set.types.includes(type) && set.enabled && set.enabledKnown !== false && !set.err && set.version === requirement.version)) {
        issues.push(`组件 ${requirement.module}@${requirement.version} 的节点 ${type} 未成功加载`);
      }
    }
  }
  return { compat, issues: [...new Set(issues)] };
}

export async function prepareFlowDeployment(
  target: AdminTarget,
  input: FlowDeploymentInput,
  fetchImpl: FetchLike = fetch,
): Promise<PreparedFlowDeployment> {
  const mode = input.mode === undefined ? (input.builtin ? 'append' : 'replace') : input.mode;
  if (mode !== 'append' && mode !== 'replace') throw new TemplateError('部署 mode 必须是 append 或 replace');
  if (input.expectedRevision !== undefined && (typeof input.expectedRevision !== 'string' || !input.expectedRevision)) {
    throw new TemplateError('expectedRevision 必须是非空流程版本');
  }
  const strict = input.builtin === true || (input.requirements?.length ?? 0) > 0;
  const flows = parseFlows(input.flows);
  const summary = summarize(flows);
  let compat: CompatResult = { ok: true, checked: false, missing: [] };
  const dependencyIssues: string[] = [];
  try {
    if (strict) {
      const checked = strictDependencies(summary.nodeTypes, input.requirements ?? [], await getInstalledNodeSets(target, fetchImpl));
      compat = checked.compat;
      dependencyIssues.push(...checked.issues);
    } else {
      compat = checkCompatibility(summary.nodeTypes, await getInstalledTypes(target, fetchImpl));
    }
  } catch {
    if (strict) dependencyIssues.push('无法读取实例组件清单，尚未确认内置模板依赖；恢复连接后重新预览');
  }
  let flowsToDeploy = flows;
  let revision: string | undefined;
  let replacedNodeCount: number | null;
  if (mode === 'append' || strict || input.mode !== undefined || input.expectedRevision !== undefined) {
    const snapshot = await getFlowSnapshot(target, fetchImpl);
    revision = snapshot.rev;
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
      throw new AdminApiError('实例流程在预览后发生变化，请重新预览后部署', 409);
    }
    if (mode === 'append') {
      dependencyIssues.push(...listenerConflicts(snapshot.flows, flows));
      flowsToDeploy = appendFlows(snapshot.flows, flows);
      replacedNodeCount = 0;
    } else {
      dependencyIssues.push(...listenerConflicts([], flows));
      replacedNodeCount = snapshot.flows.length;
    }
  } else {
    const current = await getFlows(target, fetchImpl).catch(() => null);
    replacedNodeCount = Array.isArray(current) ? current.length : null;
  }
  const deployable = dependencyIssues.length === 0;
  const note = !deployable
    ? dependencyIssues.join('；')
    : !compat.checked
      ? '未能确认节点清单；请在部署后检查节点是否正常加载'
      : !compat.ok
        ? `缺少节点：${compat.missing.join('、')}，这些节点将无法运行`
        : mode === 'append' ? '检查通过，将保留现有流程并新增采集流程' : '检查通过，将整体替换当前实例流程';
  return {
    ...summary, mode, compat, dependencyIssues, deployable, note,
    warnings: scanInlineSecrets(flows), ...(revision ? { revision } : {}),
    replacedNodeCount, resultNodeCount: flowsToDeploy.length, flowsToDeploy,
  };
}

export async function deployPreparedFlows(
  target: AdminTarget,
  prepared: PreparedFlowDeployment,
  fetchImpl: FetchLike = fetch,
): Promise<{ status: number }> {
  if (!prepared.deployable) throw new TemplateError(`部署检查未通过：${prepared.dependencyIssues.join('；')}`);
  if (prepared.revision) {
    return setFlowSnapshot(target, { rev: prepared.revision, flows: prepared.flowsToDeploy },
      prepared.mode === 'append' ? 'flows' : 'full', fetchImpl);
  }
  return setFlows(target, prepared.flowsToDeploy, fetchImpl);
}
