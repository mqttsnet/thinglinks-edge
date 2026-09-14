import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewModbusConnection} from './connection-review.ts';

test('shows real protocol range and conventional manual references separately', () => {
  const result = reviewModbusConnection({host:'192.168.1.20',port:502,address:100,quantity:4,registerType:'HoldingRegister'});
  assert.equal(result.endpoint,'192.168.1.20:502');
  assert.deepEqual(result.range,{start:100,end:103,quantity:4,functionCode:3,reference:'40101–40104'});
  assert.equal(reviewModbusConnection({address:0,quantity:2,registerType:'InputRegister'}).range?.reference,'30001–30002');
});

test('does not invent five-digit manual addresses or valid ranges for invalid inputs', () => {
  assert.equal(reviewModbusConnection({address:65535,quantity:1,registerType:'HoldingRegister'}).range?.reference,undefined);
  for(const values of [{address:65535,quantity:2},{address:0.5,quantity:2},{address:0,quantity:126}]) {
    const result=reviewModbusConnection({...values,registerType:'HoldingRegister'});
    assert.equal(result.range,undefined);
    assert.ok(result.notices.some(n=>n.code==='invalid-range'));
  }
});

test('loopback addresses describe the instance and timing warnings preserve legacy settings', () => {
  for(const host of ['127.0.0.1','127.2.3.4','localhost','::1']) {
    assert.ok(reviewModbusConnection({host}).notices.some(n=>n.code==='loopback'));
  }
  assert.equal(reviewModbusConnection({host:'192.168.1.20'}).notices.some(n=>n.code==='loopback'),false);
  assert.ok(reviewModbusConnection({interval:1}).notices.some(n=>n.code==='slow-polling'));
  assert.equal(reviewModbusConnection({interval:5,clientTimeout:2000}).notices.some(n=>n.code==='slow-polling'),false);
  assert.ok(reviewModbusConnection({interval:5,clientTimeout:5000}).notices.some(n=>n.code==='slow-polling'));
});
