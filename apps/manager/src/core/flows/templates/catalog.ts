import { TemplateError, type FlowTemplate, type FlowTemplateWithContent } from '../types.ts';
import { summarize } from '../parse.ts';
import { parameterDefaults, validateParameters } from './parameters.ts';
import { tcpRecipe } from './builtin/tcp.ts';
import { udpRecipe } from './builtin/udp.ts';
import { httpPollRecipe, httpReceiveRecipe } from './builtin/http.ts';
import { modbusRecipe } from './builtin/modbus.ts';
import { opcuaRecipe } from './builtin/opcua.ts';
import { controlledOpcuaRecipe } from './builtin/opcua-controlled.ts';
import { s7Recipe } from './builtin/s7.ts';
import { binaryTypes, scalarTypes } from './builtin/common.ts';
import type { TemplateRecipe } from './types.ts';
import { controlParameters, attachControlFlow, controlRequirements } from './control-flow.ts';

const recipes: TemplateRecipe[] = [
  tcpRecipe,
  udpRecipe,
  httpPollRecipe,
  httpReceiveRecipe,
  modbusRecipe,
  opcuaRecipe,
  s7Recipe,
  controlledOpcuaRecipe,
].map((recipe) => {
  const controls = controlParameters(recipe.protocols[0]!, recipe.controlSupported);
  const unavailableReason = controls.find(field => field.key === 'downlinkEnabled')?.disabledReason;
  return {
    ...recipe,
    parameters: [...recipe.parameters, ...controls],
    notes: [
      ...recipe.notes,
      ...(recipe.controlSupported === false && unavailableReason ? [unavailableReason] : []),
      ...(unavailableReason || recipe.protocols.includes('opcua') ? [] : ['设备控制默认关闭；启用后只执行明确映射的单参数命令，并等待设备确认。TCP/UDP 控制需设备支持约定的 JSON 请求/应答。']),
    ],
  };
});
const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));

export function isBuiltinTemplateId(id: string): boolean {
  return id.startsWith('builtin:');
}

function materialize(
  recipe: TemplateRecipe,
  parameters: Record<string, unknown>,
  disabled: boolean,
): FlowTemplateWithContent {
  const flows = attachControlFlow(recipe.protocols[0]!, parameters, recipe.build(parameters));
  for (const node of flows) if (node.type === 'tab') node.disabled = disabled;
  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    source: 'builtin',
    origin: 'builtin',
    category: recipe.category,
    protocols: [...recipe.protocols],
    revision: recipe.revision,
    requirements:
      parameters.downlinkEnabled === true
        ? controlRequirements(recipe.protocols[0]!, recipe.requirements)
        : structuredClone(recipe.requirements),
    parameters: structuredClone(recipe.parameters),
    notes: [...recipe.notes],
    warnings: [],
    createdBy: 'ThingLinks',
    createdAt: '2026-09-09T00:00:00Z',
    ...summarize(flows),
    flows,
  };
}

export function getBuiltinTemplate(id: string): FlowTemplateWithContent | undefined {
  const recipe = byId.get(id);
  return recipe ? materialize(recipe, parameterDefaults(recipe.parameters), true) : undefined;
}

export function listBuiltinTemplates(): FlowTemplate[] {
  return recipes.map((recipe) => {
    const { flows: _flows, ...metadata } = getBuiltinTemplate(recipe.id)!;
    return metadata;
  });
}

export function renderBuiltinTemplate(id: string, input: unknown): FlowTemplateWithContent | undefined {
  const recipe = byId.get(id);
  if (!recipe) return undefined;
  const p = validateParameters(recipe.parameters, input);
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,127}$/.test(String(p.nodeId)))
    throw new TemplateError('子设备标识格式不合法');
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(String(p.serviceCode)))
    throw new TemplateError('服务编码格式不合法');
  const properties = new Set<string>();
  for (const point of p.points as Record<string, unknown>[]) {
    const property = String(point.property);
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(property) ||
      ['__proto__', 'prototype', 'constructor'].includes(property)
    )
      throw new TemplateError('物模型属性编码格式不合法');
    if (properties.has(property)) throw new TemplateError(`物模型属性编码重复：${property}`);
    properties.add(property);
    if (
      String(point.source)
        .split('.')
        .some((v) => ['__proto__', 'prototype', 'constructor'].includes(v))
    )
      throw new TemplateError('源字段路径不合法');
    if (p.format === 'binary') {
      if (
        !/^\d+$/.test(String(point.source)) ||
        Number(point.source) > 65535 ||
        !binaryTypes.includes(String(point.dataType))
      )
        throw new TemplateError('二进制点位需要有效字节偏移和二进制数据类型');
    } else if (p.format === 'json' && !scalarTypes.includes(String(point.dataType)))
      throw new TemplateError('JSON 点位请选择数值、布尔或文本类型');
  }
  return { ...materialize(recipe, p, false), parameterValues: structuredClone(p) };
}
