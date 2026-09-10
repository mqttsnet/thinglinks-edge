import type { ModelCommandParameter, ProductModel } from '../model-client.ts';

const integerTypes = new Set(['int', 'integer', 'long', 'short', 'byte', 'int16', 'int32', 'int64', 'uint16', 'uint32', 'uint64']);
const decimalTypes = new Set(['decimal', 'float', 'double', 'number']);
function bound(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) throw new Error('物模型数值约束无法解析');
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('物模型数值约束不是有限数值');
  return result;
}
function checkValue(definition: ModelCommandParameter, value: unknown): string | undefined {
  const type = definition.datatype?.toLowerCase();
  try {
    if (integerTypes.has(type ?? '') || decimalTypes.has(type ?? '')) {
      if (typeof value !== 'number' || !Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)
        || integerTypes.has(type!) && !Number.isSafeInteger(value)) return '参数不是声明的安全数值类型';
      const min = bound(definition.min), max = bound(definition.max);
      if (min !== undefined && value < min || max !== undefined && value > max) return '参数超出物模型范围';
    } else if (type === 'bool' || type === 'boolean') {
      if (typeof value !== 'boolean') return '参数必须是布尔值';
    } else if (type === 'string' || type === 'text') {
      if (typeof value !== 'string') return '参数必须是文本';
      const max = bound(definition.maxlength);
      if (max !== undefined && (!Number.isSafeInteger(max) || max < 0)) return '物模型maxlength无效';
      if (max !== undefined && value.length > max) return '参数超过物模型文本长度';
    } else return '物模型参数类型暂不支持安全校验';
    if (definition.enumlist) {
      let values: unknown;
      try { values = JSON.parse(definition.enumlist); } catch { return '物模型枚举定义不是可验证的JSON数组'; }
      if (!Array.isArray(values) || values.length === 0 || values.length > 256 || values.some(item => !['string', 'number', 'boolean'].includes(typeof item))) return '物模型枚举定义不是标量数组';
      if (!values.includes(value)) return '参数不在物模型枚举范围内';
    }
  } catch (error) { return (error as Error).message; }
  return undefined;
}

/** Uses the exact cached product/version only. No clipping, coercion or inferred command fields. */
export function validateModelCommand(model: ProductModel, serviceCode: string, commandCode: string, params: Record<string, unknown>): string[] {
  const services = (model.services ?? []).filter(service => service.serviceCode === serviceCode);
  if (services.length !== 1) return ['物模型服务不存在或重复'];
  const commands = (services[0]!.commands ?? []).filter(command => command.commandCode === commandCode);
  if (commands.length !== 1) return ['物模型命令不存在或重复'];
  const definitions = commands[0]!.requests ?? [];
  const map = new Map(definitions.map(definition => [definition.parameterCode, definition]));
  if (map.size !== definitions.length) return ['物模型参数编码重复'];
  const issues: string[] = [];
  for (const definition of definitions) {
    const required = definition.required === undefined || ['1', 'true', 1, true].includes(definition.required);
    if (required && (!Object.hasOwn(params, definition.parameterCode) || params[definition.parameterCode] === null)) issues.push(`缺少物模型必填参数 ${definition.parameterCode}`);
  }
  for (const [name, value] of Object.entries(params)) {
    const definition = map.get(name);
    if (!definition) issues.push(`物模型未声明参数 ${name}`);
    else {
      const issue = checkValue(definition, value);
      if (issue) issues.push(`${name}: ${issue}`);
    }
  }
  return issues;
}
