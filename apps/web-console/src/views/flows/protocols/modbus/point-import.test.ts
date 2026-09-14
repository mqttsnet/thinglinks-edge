import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyModbusPointImport, previewModbusPointImport } from './point-import.ts';

const values = { address: 100, quantity: 6, registerType: 'HoldingRegister', host: '192.0.2.10', points: [{ property: 'old' }] };
const header = 'source,property,dataType,scale,offset\n';

test('relative CSV preserves configured read range and maps canonical fields', () => {
  const result = previewModbusPointImport(`${header}0,temperature,int16be,0.1,-2\n2,energy,uint32be,1,0`, 'relative', values);
  assert.deepEqual(result.issues, []);
  const applied = applyModbusPointImport(values, result);
  assert.equal(applied.address, 100); assert.equal(applied.quantity, 6); assert.equal(applied.host, values.host);
  assert.deepEqual(applied.points, [
    { source: '0', property: 'temperature', dataType: 'int16be', scale: 0.1, offset: -2 },
    { source: '2', property: 'energy', dataType: 'uint32be', scale: 1, offset: 0 },
  ]);
  assert.deepEqual(values.points, [{ property: 'old' }]);
});

test('Excel TSV Chinese headers, BOM, CRLF and blank lines work', () => {
  const text = '\uFEFF地址\t物模型属性编码\t数据类型\t倍率\t偏移\r\n\r\n102\tpressure\tfloat32swap\t\t\r\n100\ttemperature\tuint16be\t1e-1\t0\r\n';
  const result = previewModbusPointImport(text, 'absolute', values);
  assert.deepEqual(result.issues, []); assert.equal(result.address, 100); assert.equal(result.quantity, 4);
  assert.equal(result.rows[0]?.point.source, '2'); assert.equal(result.rows[0]?.line, 3);
  assert.equal(result.rows[0]?.point.scale, 1); assert.equal(result.rows[0]?.point.offset, 0);
  assert.equal(result.rows[1]?.point.scale, 0.1);
});

test('absolute addresses use smallest continuous read interval including 32-bit last point', () => {
  const result = previewModbusPointImport(`${header}65534,total,uint32le,1,0\n65532,value,int16le,1,0`, 'absolute', values);
  assert.deepEqual(result.issues, []); assert.equal(result.address, 65532); assert.equal(result.quantity, 4);
  assert.equal(result.rows[0]?.point.source, '2'); assert.equal(result.rows[1]?.point.source, '0');
  const applied = applyModbusPointImport(values, result);
  assert.equal(applied.quantity, 4); assert.equal(applied.address, 65532);
});

test('manual addresses require explicit interpretation and correct FC3 or FC4', () => {
  for (const [manual, registerType] of [[40001, 'HoldingRegister'], [30001, 'InputRegister']] as const) {
    const result = previewModbusPointImport(`${header}${manual},p,uint16be,1,0`, 'manual', { ...values, registerType });
    assert.deepEqual(result.issues, []); assert.equal(result.address, 0); assert.equal(result.quantity, 1);
  }
  assert.match(previewModbusPointImport(`${header}30001,p,uint16be,1,0`, 'manual', values).issues.join(), /FC3/);
  assert.match(previewModbusPointImport(`${header}40001,p,uint16be,1,0`, 'manual', { ...values, registerType: 'InputRegister' }).issues.join(), /FC4/);
  assert.ok(previewModbusPointImport(`${header}400001,p,uint16be,1,0`, 'manual', values).issues.length);
  const absolute = previewModbusPointImport(`${header}40001,p,uint16be,1,0`, 'absolute', values);
  assert.equal(absolute.address, 40001, 'zero-based address mode never guesses manual notation');
});

test('relative range must already cover every full-width point', () => {
  assert.match(previewModbusPointImport(`${header}5,p,float32be,1,0`, 'relative', values).issues.join(), /读取范围/);
  assert.ok(previewModbusPointImport(`${header}0,p,uint16be,1,0`, 'relative', { ...values, address: 65535, quantity: 2 }).issues.length);
  assert.ok(previewModbusPointImport(`${header}0,p,uint16be,1,0`, 'relative', { ...values, address: '0' }).issues.length);
});

test('point count and continuous read interval enforce protocol limits', () => {
  const rows = Array.from({ length: 65 }, (_, i) => `${i},p${i},uint16be,1,0`);
  assert.match(previewModbusPointImport(header + rows.join('\n'), 'absolute', values).issues.join(), /64/);
  assert.deepEqual(previewModbusPointImport(header + rows.slice(0, 64).join('\n'), 'absolute', values).issues, []);
  assert.equal(previewModbusPointImport(`${header}0,a,uint16be,1,0\n124,b,uint16be,1,0`, 'absolute', values).quantity, 125);
  assert.match(previewModbusPointImport(`${header}0,a,uint16be,1,0\n124,b,float32be,1,0`, 'absolute', values).issues.join(), /125/);
  assert.match(previewModbusPointImport(`${header}65535,a,float32be,1,0`, 'absolute', values).issues.join(), /65535/);
});

test('reject duplicate or unsafe property codes and unsupported data types with row numbers', () => {
  for (const property of ['__proto__', 'constructor', 'prototype', '1first', 'has.dot', '中文', 'x'.repeat(65)]) {
    assert.match(previewModbusPointImport(`${header}0,${property},uint16be,1,0`, 'relative', values).issues.join(), /第 2 行/);
  }
  assert.match(previewModbusPointImport(`${header}0,p,uint16be,1,0\n1,p,uint16be,1,0`, 'relative', values).issues.join(), /第 3 行.*重复/);
  for (const type of ['number', 'uint64be', '', 'float']) {
    assert.match(previewModbusPointImport(`${header}0,p,${type},1,0`, 'relative', values).issues.join(), /数据类型/);
  }
});

test('reject ambiguous integer addresses and nonfinite or out-of-bound numeric conversion', () => {
  for (const source of ['-1', '1.2', '0x01', '1e2', '', '65536', 'Infinity']) {
    assert.ok(previewModbusPointImport(`${header}${source},p,uint16be,1,0`, 'absolute', values).issues.length, source);
  }
  for (const number of ['NaN', 'Infinity', '1e999', '0x10', '1000000000001', 'false']) {
    assert.match(previewModbusPointImport(`${header}0,p,uint16be,${number},0`, 'relative', values).issues.join(), /倍率/);
    assert.match(previewModbusPointImport(`${header}0,p,uint16be,1,${number}`, 'relative', values).issues.join(), /偏移/);
  }
});

test('quoted CSV is parsed strictly and never split on a quoted comma or newline', () => {
  const valid = previewModbusPointImport('"source","property","dataType","scale","offset"\n"0","p","uint16be","1","0"', 'relative', values);
  assert.deepEqual(valid.issues, []);
  for (const row of ['0,"has,comma",uint16be,1,0', '0,"has""quote",uint16be,1,0', '0,"has\nnewline",uint16be,1,0']) {
    const invalidProperty = previewModbusPointImport(header + row, 'relative', values);
    assert.match(invalidProperty.issues.join(), /属性编码/);
    assert.doesNotMatch(invalidProperty.issues.join(), /列数/);
  }
  for (const row of ['0,"unfinished,uint16be,1,0', '0,"p"oops,uint16be,1,0', '0,p"oops,uint16be,1,0']) {
    assert.match(previewModbusPointImport(header + row, 'relative', values).issues.join(), /引号/);
  }
});

test('headers and row width must exactly match five documented columns', () => {
  for (const text of ['0,p,uint16be,1,0', 'source,property,dataType,offset,scale\n0,p,uint16be,0,1', 'source,property,type,scale,offset\n0,p,uint16be,1,0']) {
    assert.match(previewModbusPointImport(text, 'relative', values).issues.join(), /表头/);
  }
  for (const row of ['0,p,uint16be,1', '0,p,uint16be,1,0,extra']) {
    assert.match(previewModbusPointImport(header + row, 'relative', values).issues.join(), /第 2 行.*5 列/);
  }
});

test('empty or oversize text and unknown runtime modes fail closed', () => {
  for (const text of ['', '\n\r\n', header, header + ',,,,\n']) {
    assert.ok(previewModbusPointImport(text, 'relative', values).issues.length);
  }
  assert.match(previewModbusPointImport('x'.repeat(65_537), 'relative', values).issues.join(), /64 Ki/);
  assert.ok(previewModbusPointImport(`${header}0,p,uint16be,1,0`, 'unknown' as 'relative', values).issues.length);
  assert.ok(previewModbusPointImport(`${header}0,p,uint16be,1,0`, 'absolute', { ...values, registerType: '' }).issues.length);
});

test('invalid preview cannot replace existing point table', () => {
  const invalid = previewModbusPointImport(`${header}0,constructor,uint16be,1,0`, 'relative', values);
  assert.throws(() => applyModbusPointImport(values, invalid), /点表/);
  assert.deepEqual(values.points, [{ property: 'old' }]);
});
