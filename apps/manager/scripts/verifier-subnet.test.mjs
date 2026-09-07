import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseVerifierSubnet } from './_verifier-subnet.mjs';

test('chooses the first verifier /28 when no occupied IPv4 range overlaps it', () => {
  assert.equal(chooseVerifierSubnet([]), '10.219.255.240/28');
  assert.equal(chooseVerifierSubnet(['172.16.0.0/12']), '10.219.255.240/28');
});

test('skips a candidate contained in a wider occupied subnet', () => {
  assert.equal(chooseVerifierSubnet(['10.219.0.0/16']), '10.220.255.240/28');
  assert.equal(chooseVerifierSubnet(['10.218.0.0/15']), '10.220.255.240/28');
  assert.throws(() => chooseVerifierSubnet(['10.0.0.0/8']), /no free verifier subnet/i);
  assert.throws(() => chooseVerifierSubnet(['0.0.0.0/0']), /no free verifier subnet/i);
});

test('skips a candidate containing a narrower occupied subnet or its final host', () => {
  assert.equal(chooseVerifierSubnet(['10.219.255.248/29']), '10.220.255.240/28');
  assert.equal(chooseVerifierSubnet(['10.219.255.255/32']), '10.220.255.240/28');
});

test('adjacent IPv4 intervals do not overlap the candidate', () => {
  assert.equal(chooseVerifierSubnet([
    '10.219.255.224/28',
    '10.220.0.0/16',
  ]), '10.219.255.240/28');
});

test('normalizes host bits before checking an occupied CIDR interval', () => {
  assert.equal(chooseVerifierSubnet(['10.219.1.7/16']), '10.220.255.240/28');
});

test('ignores valid IPv6 CIDRs including a default route and an IPv4-mapped address', () => {
  assert.equal(chooseVerifierSubnet([
    '::/0',
    '2001:db8::/32',
    'fd00::1/128',
    '::ffff:10.219.255.240/128',
  ]), '10.219.255.240/28');
});

test('tries candidates in order through the inclusive final candidate', () => {
  const occupied = Array.from({ length: 34 }, (_, index) => `10.${219 + index}.0.0/16`);
  assert.equal(chooseVerifierSubnet(occupied), '10.253.255.240/28');
});

test('fails when all verifier candidates are occupied', () => {
  const occupied = Array.from({ length: 35 }, (_, index) => `10.${219 + index}.255.240/28`);
  assert.throws(() => chooseVerifierSubnet(occupied), /no free verifier subnet/i);
});

test('rejects invalid CIDRs even when a free candidate could otherwise be selected', () => {
  for (const cidr of [
    '', '10.0.0.0', '10.0.0.0/', '10.0.0.0/33', '10.0.0.256/24',
    '10.0.0.0/-1', '10.0.0.0/2.5', '10.0.0.0/24/8', '10.0.0.0/24 ',
    '10.0.0.01/24', '::/129', '::gggg/64', '::/invalid', 'fe80::1%en0/64',
    null, undefined, 123,
  ]) {
    assert.throws(() => chooseVerifierSubnet(['172.16.0.0/12', cidr]), /invalid CIDR/i);
  }
});

test('requires an array of CIDRs and does not change the supplied inventory', () => {
  for (const input of [undefined, null, '10.0.0.0/8', new Set()]) {
    assert.throws(() => chooseVerifierSubnet(input), /array/i);
  }
  const occupied = Object.freeze(['10.219.0.0/16', '192.168.0.0/16']);
  assert.equal(chooseVerifierSubnet(occupied), '10.220.255.240/28');
  assert.deepEqual(occupied, ['10.219.0.0/16', '192.168.0.0/16']);
});
