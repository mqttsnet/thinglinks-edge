import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewPointImport, applyPointImport } from './point-import.ts';
import type { TemplateParameter } from '../../../../api/types.ts';
const schema: TemplateParameter = { key: 'points', label: '点表', type: 'table', min: 1, max: 64, columns: [
  {key:'source',label:'源字段',type:'text',required:true,max:256},
  {key:'property',label:'属性编码',type:'text',required:true,max:64},
  {key:'dataType',label:'类型',type:'select',options:['number','boolean','string','float32be'].map(value=>({value,label:value}))},
  {key:'scale',label:'倍率',type:'number',default:1,min:-1e12,max:1e12},
  {key:'offset',label:'偏移',type:'number',default:0,min:-1e12,max:1e12},
]};
test('NodeId text identities preserve significant spaces when requested by the recipe', () => {
  const opcSchema={...schema,columns:schema.columns!.map(c=>c.key==='source'?{...c,preserveWhitespace:true}:c)};
  const result=previewPointImport('source,property,dataType,scale,offset\n"ns=2;s=Temperature ",p,number,1,0',opcSchema,{});
  assert.deepEqual(result.issues,[]);assert.equal(result.rows[0]!.point.source,'ns=2;s=Temperature ');
});
test('Excel and quoted CSV preserve PLC commas, OPC NodeIds and explicit property mappings', () => {
  for(const text of ['source,property,dataType,scale,offset\n"DB1,REAL0",temperature,number,0.1,1',
    '地址\t属性编码\t数据类型\t倍率\t偏移\nDB1,REAL0\ttemperature\tnumber\t0.1\t1']) {
    const preview=previewPointImport(text,schema,{});assert.deepEqual(preview.issues,[]);
    assert.equal(preview.rows[0]!.point.source,'DB1,REAL0');
    const values={host:'192.0.2.1',points:[{property:'old'}],commands:[{cmd:'retained'}]};
    const applied=applyPointImport(values,preview);assert.equal(applied.host,values.host);assert.equal(applied.commands,values.commands);
    assert.equal(values.points[0]!.property,'old');
  }
});
test('bad rows and wrong format cannot replace existing points', () => {
  for(const row of ['a,__proto__,number,1,0','a,p,other,1,0','a,p,number,NaN,0','a,p,number,1e99,0','a,p,number,1']) {
    const preview=previewPointImport('source,property,dataType,scale,offset\n'+row,schema,{});
    assert.ok(preview.issues.some(x=>x.includes('第 2 行')));assert.throws(()=>applyPointImport({},preview));
  }
  const duplicate=previewPointImport('source,property,dataType,scale,offset\na,p,number,1,0\nb,p,number,1,0',schema,{});
  assert.match(duplicate.issues.join(''),/重复/);
  assert.ok(previewPointImport('source,property,dataType,scale,offset\n0,p,number,1,0',schema,{format:'binary'}).issues.length);
  assert.ok(previewPointImport('source,property,dataType,scale,offset\n0,p,float32be,1,0',schema,{format:'json'}).issues.length);
});
test('limits and defaults keep import bounded and do not guess numeric values', () => {
  const p=previewPointImport('source,property,dataType,scale,offset\na,p,number,,',schema,{});
  assert.deepEqual(p.issues,[]);assert.equal(p.rows[0]!.point.scale,1);assert.equal(p.rows[0]!.point.offset,0);
  assert.ok(previewPointImport('x'.repeat(65537),schema,{}).issues.length);
  assert.ok(previewPointImport('source,property,dataType,scale,offset\n'+Array.from({length:65},(_,i)=>`a,p${i},number,1,0`).join('\n'),schema,{}).issues.length);
});
