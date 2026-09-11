/* global Buffer */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { crc16, describeFrame, corruptResponse } = require('./wire.cjs');
test('CRC matches standard FC3 request golden bytes and detects damage', () => {
 const bytes=Buffer.from('010300000002c40b','hex');
 assert.equal(crc16(bytes.subarray(0,-2)),0x0bc4);
 assert.equal(describeFrame(bytes).crcValid,true);
 bytes[3]^=1;assert.equal(describeFrame(bytes).crcValid,false);
});
test('faults change only simulated response bytes, not client code',()=>{
 const source=Buffer.from('01030200fa3837','hex');
 const valid=Buffer.from(source);valid.writeUInt16LE(crc16(valid.subarray(0,-2)),valid.length-2);
 assert.equal(describeFrame(corruptResponse(valid,'bad-crc')).crcValid,false);
 const wrong=corruptResponse(valid,'wrong-unit');assert.equal(wrong[0],2);assert.equal(describeFrame(wrong).crcValid,true);
 assert.equal(corruptResponse(valid,'truncated').length,valid.length-2);
 assert.deepEqual(valid,corruptResponse(valid,'none'));
});
