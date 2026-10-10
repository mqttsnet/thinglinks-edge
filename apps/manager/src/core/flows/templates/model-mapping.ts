import type {
  ModelCommand,
  ModelCommandParameter,
  ModelProperty,
  ModelService,
  ProductModel,
} from '../../cloud/model-client.ts';
import { TemplateError } from '../types.ts';
import { validateParameters } from './parameters.ts';
import type { TemplateParameter } from './types.ts';
import { resolvePoints, resolveServiceCode, pointIdentity } from './service-mapping.ts';
import { resolveControlMappings } from './control-mapping.ts';

type ValueFamily = 'number' | 'boolean' | 'string';
const numberTypes = new Set([
  'number',
  'decimal',
  'float',
  'double',
  'int',
  'integer',
  'long',
  'short',
  'byte',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
]);
function family(value: unknown, sourceCodec = false): ValueFamily | undefined {
  const type = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (numberTypes.has(type) || (sourceCodec && /^(?:u?int(?:16|32)|float32)(?:be|le|swap)$/.test(type)))
    return 'number';
  if (type === 'bool' || type === 'boolean') return 'boolean';
  if (type === 'string' || type === 'text') return 'string';
  return undefined;
}
function code(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function records(value: unknown, label: string): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
  ) {
    throw new TemplateError(`${label}不是有效列表`);
  }
  return value as Record<string, unknown>[];
}
function unique<T>(items: T[] | undefined, key: keyof T, value: string, label: string): T {
  if (!Array.isArray(items)) throw new TemplateError(`${label} ${value} 的云端定义缺失`);
  const matches = items.filter((item) => item && typeof item === 'object' && item[key] === value);
  if (matches.length !== 1) throw new TemplateError(`${label} ${value} 在所选物模型中不存在或重复`);
  return matches[0]!;
}
function compatible(sourceType: unknown, cloudType: unknown, label: string): void {
  const source = family(sourceType, true),
    target = family(cloudType);
  if (!source || !target || source !== target) {
    throw new TemplateError(
      `${label} 类型不兼容：点位输出 ${String(sourceType ?? '未声明')}，云端声明 ${String(cloudType ?? '未声明')}`,
    );
  }
}

/** Checks mapping identity and scalar families only; real command values are validated at execution. */
export function validateTemplateModelMappings(
  parameters: Record<string, unknown>,
  model: ProductModel,
): void {
  const product = code(parameters['productIdentification']);
  if (model.productIdentification && product && model.productIdentification !== product)
    throw new TemplateError('缓存物模型产品与当前子设备产品不一致');
  const services = new Map<string, ModelService>();
  const serviceFor = (value: string): ModelService => {
    const serviceCode = resolveServiceCode(value);
    let service = services.get(serviceCode);
    if (!service) {
      service = unique<ModelService>(model.services, 'serviceCode', serviceCode, '服务');
      services.set(serviceCode, service);
    }
    return service;
  };
  const points = resolvePoints(records(parameters['points'], '采集点位'), parameters['serviceCode']);
  const targets = new Map(points.map(point => [pointIdentity(point.serviceCode, point.property), point]));
  for (const point of points) {
    const service = serviceFor(point.serviceCode);
    const property = unique<ModelProperty>(
      service.properties,
      'propertyCode',
      code(point['property']),
      `服务 ${point.serviceCode} 的属性`,
    );
    compatible(point['dataType'], property.datatype, `服务 ${point.serviceCode} 的属性 ${property.propertyCode}`);
  }
  if (parameters['downlinkEnabled'] !== true) return;
  for (const mapping of resolveControlMappings(parameters['commands'], points, parameters['serviceCode'])) {
    const service = serviceFor(mapping.serviceCode);
    const command = unique<ModelCommand>(service.commands, 'commandCode', mapping.cmd, `服务 ${mapping.serviceCode} 的命令`);
    const parameter = unique<ModelCommandParameter>(
      command.requests,
      'parameterCode',
      mapping.param,
      `服务 ${mapping.serviceCode} 的命令参数`,
    );
    const requests = command.requests!;
    if (
      requests.some((item) => !item || typeof item.parameterCode !== 'string') ||
      new Set(requests.map((item) => item.parameterCode)).size !== requests.length
    )
      throw new TemplateError(`命令 ${command.commandCode} 的参数定义无效或重复`);
    for (const request of requests) {
      // Match the runtime command validator: unspecified required flags are treated conservatively.
      const required = request.required === undefined || ['1', 'true', 1, true].includes(request.required);
      if (required && request.parameterCode !== parameter.parameterCode) {
        throw new TemplateError(
          `命令 ${command.commandCode} 还需要必填参数 ${request.parameterCode}，当前模板仅支持单参数映射`,
        );
      }
    }
    const target = targets.get(pointIdentity(mapping.targetServiceCode, mapping.property));
    if (!target) throw new TemplateError(`命令 ${mapping.serviceCode} / ${command.commandCode} 的目标点位不存在`);
    compatible(target['dataType'], parameter.datatype, `服务 ${mapping.serviceCode} 的命令参数 ${parameter.parameterCode}`);
  }
}

/** A cache miss remains unverified. Never substitute the gateway product or version. */
export function checkCachedTemplateModelMappings(
  input: unknown,
  fields: TemplateParameter[],
  lookup: ((productIdentification: string, versionNo: string) => ProductModel | undefined) | undefined,
): boolean {
  const parameters = validateParameters(fields, input);
  const product = code(parameters['productIdentification']),
    version = code(parameters['versionNo']);
  if (!product || !version || !lookup) return false;
  const model = lookup(product, version);
  if (!model) return false;
  validateTemplateModelMappings(parameters, model);
  return true;
}
