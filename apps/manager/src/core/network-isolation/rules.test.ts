import { test } from 'node:test';
const owner = '1'.repeat(32);
import assert from 'node:assert/strict';
import { parseDescriptor } from './descriptor.ts';
import { buildRuleSet, canonicalRule } from './rules.ts';

const input = { networkId: 'a'.repeat(64), cidr: '172.23.0.0/16', gateway: '172.23.0.1', bridge: 'br-aaaaaaaaaaaa', ipv6Enabled: false,
  protectedHosts: ['192.168.65.254'], peerCIDRs: ['172.24.0.0/16'], allowedHostEndpoints: [
    { address: '192.168.65.254', port: 4840, protocol: 'tcp' }, { address: '192.168.65.254', port: 5683, protocol: 'udp' },
  ] };

test('rules preserve health queries and precise TCP/UDP exceptions before protected host/peer drops', () => {
  const rules = buildRuleSet(parseDescriptor(input), 31555, owner);
  assert.match(rules.restore, /^\*filter\n:TLE_N_[a-f0-9]+ - \[0:0\]\n/);
  assert.match(rules.restore, /--dport 31555 .* -j RETURN/);
  assert.match(rules.restore, /-p tcp -m conntrack --ctorigdst 192.168.65.254 --ctorigdstport 4840 .* -j RETURN/);
  assert.match(rules.restore, /-p udp -m conntrack --ctorigdst 192.168.65.254 --ctorigdstport 5683 .* -j RETURN/);
  assert.ok(rules.restore.indexOf('--ctorigdstport 5683') < rules.restore.indexOf('-d 172.24.0.0/16 -m comment'));
  assert.deepEqual(rules.hook, ['-s', '172.23.0.0/16', '-i', 'br-aaaaaaaaaaaa', '-j', rules.chain]);
  assert.ok(!rules.restore.includes('-P '));
  assert.ok(!rules.restore.includes(':INPUT'));
  assert.ok(!rules.restore.includes(':DOCKER-USER'));
  assert.ok(rules.restore.endsWith('COMMIT\n'));
});

test('rule readback tolerates /32 rendering without overlooking rule order or a broad ACCEPT', () => {
  assert.equal(canonicalRule('-A OWN -d 172.23.0.1/32 -p tcp -m tcp --dport 31555 -j RETURN'), canonicalRule('-A OWN -d 172.23.0.1 -p tcp -m tcp --dport 31555 -j RETURN'));
  assert.notEqual(canonicalRule('-A OWN -j ACCEPT'), canonicalRule('-A OWN -j RETURN'));
});

test('only the reply direction of established inbound traffic precedes host drops', () => {
  const rules = buildRuleSet(parseDescriptor(input), 31555, owner);
  const reply = rules.rules.find(rule => rule.includes('--ctdir'));
  assert.deepEqual(reply!.slice(0, 6), ['-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '--ctdir', 'REPLY']);
  assert.deepEqual(reply!.slice(-2), ['-j', 'RETURN']);
  assert.ok(reply!.includes(`tle-net:${owner}:${input.networkId}`));
  assert.ok(rules.rules.indexOf(reply!) < rules.rules.findIndex(rule => rule.includes('DROP')));
  assert.equal(rules.rules.filter(rule => rule.includes('--ctstate')).length, 1);
  assert.ok(!rules.restore.includes('--ctdir ORIGINAL -j RETURN'));
  assert.equal(canonicalRule('-A OWN -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -j RETURN'), canonicalRule('-A OWN -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN'));
  assert.notEqual(canonicalRule('-A OWN -m conntrack --ctstate ESTABLISHED,RELATED --ctdir ORIGINAL -j RETURN'), canonicalRule('-A OWN -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN'));
});


test('real iptables-save quoting and state ordering normalize only known syntax', () => {
  const marker = `tle-net:${owner}:${input.networkId}`;
  assert.equal(canonicalRule(`-A OWN -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -m comment --comment "${marker}" -j RETURN`), canonicalRule(`-A OWN -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -m comment --comment ${marker} -j RETURN`));
  assert.notEqual(canonicalRule(`-A OWN ! -d 172.23.0.1/32 -m comment --comment "${marker}" -j DROP`), canonicalRule(`-A OWN -d 172.23.0.1 -m comment --comment ${marker} -j DROP`));
});
