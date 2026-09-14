const aliases: Record<string, string[]> = {
  source: ['source', '地址', '源字段', '变量地址', 'nodeid', '寄存器地址', '寄存器相对偏移', '相对偏移'],
  property: ['property', '属性编码', '物模型属性编码'],
  dataType: ['datatype', '数据类型'], scale: ['scale', '倍率'], offset: ['offset', '偏移'],
  serviceCode: ['servicecode', '服务编码', '服务'],
};
const required = ['source', 'property', 'dataType', 'scale', 'offset'];
/** Headers identify columns; a service column is optional and original five-column sheets remain valid. */
export function pointImportColumns(cells: string[] | undefined): Map<string, number> | null {
  if (!cells || ![5, 6].includes(cells.length)) return null;
  const indices = new Map<string, number>();
  for (const [index, cell] of cells.entries()) {
    const key = Object.keys(aliases).find(key => aliases[key]!.includes(cell.trim().toLowerCase()));
    if (!key || indices.has(key)) return null;
    indices.set(key, index);
  }
  return required.every(key => indices.has(key)) ? indices : null;
}
export const POINT_IMPORT_HEADER_HELP = '表头需要地址（source）、属性编码（property）、数据类型（dataType）、倍率（scale）、偏移（offset），可增加服务编码（serviceCode）列；按表头识别，顺序不限。';
