import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpcuaNodeId, s7ScalarAddress } from './industrial-address.ts';

test('NodeId normalizes equivalent numeric/namespace/GUID forms without altering String identifier contents', () => {
  assert.equal(normalizeOpcuaNodeId('i=001'), 'ns=0;i=1');
  assert.equal(normalizeOpcuaNodeId('ns=000;i=1'), 'ns=0;i=1');
  assert.equal(normalizeOpcuaNodeId('ns=01;s= Value with spaces '), 'ns=1;s= Value with spaces ');
  assert.notEqual(normalizeOpcuaNodeId('ns=1;s=Value '), normalizeOpcuaNodeId('ns=1;s=Value'));
  assert.equal(normalizeOpcuaNodeId('ns=1;g=aabbccdd-1122-3344-5566-778899aabbcc'), 'ns=1;g=AABBCCDD-1122-3344-5566-778899AABBCC');
  assert.equal(normalizeOpcuaNodeId('ns=65535;i=4294967295'), 'ns=65535;i=4294967295');
  assert.equal(normalizeOpcuaNodeId('b=AQIDBA=='), 'ns=0;b=AQIDBA==');
});

test('NodeId rejects malformed identifiers and reserved node-property suffixes', () => {
  for (const source of ['ns=65536;i=1', 'ns=-1;i=1', 'i=1x', 'i=4294967296', 'i=-1', 's=', 's=a\u0085b', 'g=aabbccdd-1122-3344-5566-778899aabbccjunk', 'b=AA=', 'b=%%%%', 'b=AB==', 's=Temperature;datatype=Float']) {
    assert.throws(() => normalizeOpcuaNodeId(source), /NodeId/);
  }
});

test('S7 scalar parser keeps pinned driver aliases, one-element arrays and character-array strings', () => {
  for (const source of ['DB1,REAL0', 'DB1,R0', 'DB2,I0', 'DB1,RWORD4', 'EW0', 'AD0', 'MRW4', 'PIW0', 'T0', 'C0', 'DB1,REAL0.1']) assert.equal(s7ScalarAddress(source).kind, 'number', source);
  for (const source of ['DB1,X0.1', 'M0.2', 'E0.0', 'Q1.7.1']) assert.equal(s7ScalarAddress(source).kind, 'boolean', source);
  for (const source of ['DB1,C0.10', 'DB1,CHAR0', 'DB1,S0.10', 'MC0.10']) assert.equal(s7ScalarAddress(source).kind, 'string', source);
  assert.equal(s7ScalarAddress('DB1,REAL2097148').width, 4);
});

test('S7 parser refuses invalid, non-scalar and wire-address-overflow input before Node-RED deployment', () => {
  for (const source of ['DB1.DBD0', 'DB0,REAL0', 'DB65536,REAL0', 'DB1,X0.8', 'DB1,REAL0.2', 'DB1,X0.0.2', 'DB1,S0.10.2', 'DB1,DT0', 'DB1,DTL0', 'DB1,STRING0', 'DB1,STRING0.255', 'DB1,REAL2097150', 'MB2097152', 'PZB0']) assert.throws(() => s7ScalarAddress(source), /地址|数组|日期|文本|数据块|位/);
});
