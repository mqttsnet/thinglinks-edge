import type { TemplateParameter } from '../../../../api/types.ts';
import { parseRows, conversionNumber } from './delimited-text.ts';

export interface ImportedPoint { source: string; property: string; dataType: string; scale: number; offset: number }
export interface PointImportPreview { rows: { line: number; point: ImportedPoint }[]; issues: string[] }
const headers = [['source','地址','源字段','变量地址','nodeid'],['property','属性编码','物模型属性编码'],['datatype','数据类型'],['scale','倍率'],['offset','偏移']];
const blocked = new Set(['__proto__','prototype','constructor']);
const scalar = new Set(['number','boolean','string']);

/** Basic import validation uses the actual recipe schema. Final protocol validation stays at the Manager boundary. */
export function previewPointImport(text: string, schema: TemplateParameter, values: Record<string, unknown>): PointImportPreview {
  const result: PointImportPreview = {rows:[],issues:[]};
  try {
    const preserveSource = schema.columns?.find(c=>c.key==='source')?.preserveWhitespace;
    const records = parseRows(text.replace(/^\uFEFF/,''), !preserveSource);
    const header = records.shift();
    if (!header || header.cells.length !== 5 || header.cells.some((cell,i)=>!headers[i]!.includes(cell.trim().toLowerCase()))) {
      result.issues.push('第一行填写固定五列表头：source,property,dataType,scale,offset（地址、属性编码、数据类型、倍率、偏移）。');return result;
    }
    if (!records.length || records.length > Math.min(64,schema.max ?? 64)) {
      result.issues.push('每次导入 1–64 个点位；较大的点表请按设备或采集组拆分。');return result;
    }
    const columns = schema.columns ?? [];
    const types = columns.find(c=>c.key==='dataType')?.options?.map(o=>String(o.value)) ?? [];
    const properties = new Set<string>();
    for (const row of records) {
      const fail=(message:string)=>result.issues.push(`第 ${row.line} 行：${message}`);
      if(row.cells.length!==5){fail('必须包含地址、属性编码、数据类型、倍率、偏移五列。含逗号的 PLC 地址请用双引号包住，或直接粘贴 Excel 五列。');continue;}
      const [source,property,rawType,scaleText,offsetText]=row.cells.map((cell,i)=>i===0&&preserveSource?cell:cell.trim()) as [string,string,string,string,string];
      const dataType=types.find(type=>type.toLowerCase()===rawType.toLowerCase());
      if(!source || source.length>(columns.find(c=>c.key==='source')?.max ?? 256)){fail('请填写长度不超过 256 的源字段或变量地址。');continue;}
      if(!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(property)||blocked.has(property)){fail('属性编码仅含字母、数字或下划线，以字母或下划线开头，且不能是保留名称。');continue;}
      if(properties.has(property)){fail(`属性编码 ${property} 重复。`);continue;}properties.add(property);
      if(!dataType){fail('数据类型不属于当前模板支持的类型，请参照下方类型表。');continue;}
      if(values.format==='json'&&!scalar.has(dataType)){fail('JSON 报文使用 number、boolean 或 string。');continue;}
      if(values.format==='binary' && (!/^\d+$/.test(source)||!Number.isSafeInteger(Number(source))||Number(source)>65535||scalar.has(dataType))){fail('二进制点位须填写从 0 开始的字节偏移和整数/浮点字节序类型。');continue;}
      const scale=conversionNumber(scaleText,1),offset=conversionNumber(offsetText,0);
      if(scale===null||offset===null){fail('倍率和偏移须为 -1e12 至 1e12 的有限数值，留空分别使用 1 和 0。');continue;}
      result.rows.push({line:row.line,point:{source,property,dataType,scale,offset}});
    }
  } catch(error) {result.issues.push(error instanceof Error?error.message:'无法解析点表。');}
  return result;
}

export function applyPointImport(values: Record<string,unknown>, preview: PointImportPreview): Record<string,unknown> {
  if(preview.issues.length||!preview.rows.length)throw new Error('请先修正点表并重新预览。');
  return {...values,points:preview.rows.map(row=>({...row.point}))};
}
