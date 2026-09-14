import type { TemplateParameter } from '../../../../api/types.ts';
import { tableRowLimit } from '../../components/table-pagination.ts';
import { parseRows, conversionNumber } from './delimited-text.ts';
import { pointImportColumns, POINT_IMPORT_HEADER_HELP } from './point-import-columns.ts';
import { effectiveService, servicePointKey, validServiceCode, MAX_TEMPLATE_SERVICES } from '../../service-identity.ts';

export interface ImportedPoint { source: string; property: string; dataType: string; scale: number; offset: number; serviceCode?: string }
export interface PointImportPreview { rows: { line: number; point: ImportedPoint }[]; issues: string[] }
const blocked = new Set(['__proto__','prototype','constructor']);
const scalar = new Set(['number','boolean','string']);

/** Basic import validation uses the actual recipe schema. Final protocol validation stays at the Manager boundary. */
export function previewPointImport(text: string, schema: TemplateParameter, values: Record<string, unknown>): PointImportPreview {
  const result: PointImportPreview = {rows:[],issues:[]};
  try {
    const preserveSource = schema.columns?.find(c=>c.key==='source')?.preserveWhitespace;
    const records = parseRows(text.replace(/^\uFEFF/,''), !preserveSource);
    const header = records.shift();
    const indices = pointImportColumns(header?.cells);
    if (!header || !indices) {
      result.issues.push(POINT_IMPORT_HEADER_HELP);return result;
    }
    const maxPoints = tableRowLimit(schema);
    if (!records.length || records.length > maxPoints) {
      result.issues.push(`每次导入 1–${maxPoints} 个点位；当前点表包含 ${records.length} 个。`);return result;
    }
    const columns = schema.columns ?? [];
    const types = columns.find(c=>c.key==='dataType')?.options?.map(o=>String(o.value)) ?? [];
    const properties = new Set<string>(), services = new Set<string>();
    for (const row of records) {
      const fail=(message:string)=>result.issues.push(`第 ${row.line} 行：${message}`);
      if(row.cells.length!==header.cells.length){fail('数据列数须与表头一致。含逗号的 PLC 地址请用双引号包住，或直接粘贴 Excel 单元格。');continue;}
      const cell = (key: string) => row.cells[indices.get(key)!] ?? '';
      const source = preserveSource ? cell('source') : cell('source').trim();
      const property = cell('property').trim(), rawType = cell('dataType').trim(), scaleText = cell('scale').trim(), offsetText = cell('offset').trim();
      const serviceCode = cell('serviceCode').trim(), service = effectiveService(serviceCode, values.serviceCode);
      if (service && !validServiceCode(service)) { fail('服务编码格式无效，最多 128 个字母、数字、下划线、短横线或点。'); continue; }
      if (service) services.add(service);
      const dataType=types.find(type=>type.toLowerCase()===rawType.toLowerCase());
      const maxSourceLength = columns.find(c=>c.key==='source')?.max ?? 256;
      if(!source || source.length>maxSourceLength){fail(`请填写长度不超过 ${maxSourceLength} 的源字段或变量地址。`);continue;}
      if(!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(property)||blocked.has(property)){fail('属性编码仅含字母、数字或下划线，以字母或下划线开头，且不能是保留名称。');continue;}
      const identity = servicePointKey(service, property);
      if(properties.has(identity)){fail(`服务 ${service || '默认服务'} 的属性编码 ${property} 重复。`);continue;}properties.add(identity);
      if(!dataType){fail('数据类型不属于当前模板支持的类型，请参照下方类型表。');continue;}
      if(values.format==='json'&&!scalar.has(dataType)){fail('JSON 报文使用 number、boolean 或 string。');continue;}
      if(values.format==='binary' && (!/^\d+$/.test(source)||!Number.isSafeInteger(Number(source))||Number(source)>65535||scalar.has(dataType))){fail('二进制点位须填写从 0 开始的字节偏移和整数/浮点字节序类型。');continue;}
      const scale=conversionNumber(scaleText,1),offset=conversionNumber(offsetText,0);
      if(scale===null||offset===null){fail('倍率和偏移须为 -1e12 至 1e12 的有限数值，留空分别使用 1 和 0。');continue;}
      result.rows.push({line:row.line,point:{source,property,dataType,scale,offset,...(indices.has('serviceCode') ? { serviceCode } : {})}});
    }
    if (services.size > MAX_TEMPLATE_SERVICES) result.issues.push(`点表涉及 ${services.size} 个服务，最多 ${MAX_TEMPLATE_SERVICES} 个。`);
  } catch(error) {result.issues.push(error instanceof Error?error.message:'无法解析点表。');}
  return result;
}

export function applyPointImport(values: Record<string,unknown>, preview: PointImportPreview): Record<string,unknown> {
  if(preview.issues.length||!preview.rows.length)throw new Error('请先修正点表并重新预览。');
  return {...values,points:preview.rows.map(row=>({...row.point}))};
}
