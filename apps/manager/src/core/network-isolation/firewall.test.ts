import { test } from 'node:test';
const owner = '1'.repeat(32);
import assert from 'node:assert/strict';
import { NetworkFirewall, type CommandRunner, type CommandResult } from './firewall.ts';
import { parseDescriptor } from './descriptor.ts';
import { buildRuleSet } from './rules.ts';

const descriptor = parseDescriptor({ networkId: 'a'.repeat(64), cidr: '172.23.0.0/16', gateway: '172.23.0.1', bridge: 'br-aaaaaaaaaaaa', ipv6Enabled: false,
  protectedHosts: ['192.168.65.254'], peerCIDRs: ['172.24.0.0/16'], allowedHostEndpoints: [] });

class Kernel implements CommandRunner {
  chains = new Map<string, string[]>([['INPUT', []], ['FORWARD', ['-A FORWARD -j DOCKER-USER']], ['DOCKER-USER', ['-A DOCKER-USER -i eth0 -j ACCEPT']]]);
  calls: Array<{ command: string; args: readonly string[]; input?: string }> = [];
  descriptors = [descriptor];
  missingBridge = false;
  failRestore = false;
  async run(command: string, args: readonly string[], input?: string): Promise<CommandResult> {
    this.calls.push({ command, args, ...(input === undefined ? {} : { input }) });
    if (command === 'ip') {
      if (args.includes('link')) return { code: 0, stdout: JSON.stringify(this.missingBridge ? [] : this.descriptors.map(value => ({ ifname: value.bridge, linkinfo: { info_kind: 'bridge' } }))), stderr: '' };
      return { code: 0, stdout: JSON.stringify([...this.descriptors.map(value => ({ ifname: value.bridge, addr_info: [{ family: 'inet', local: value.gateway, prefixlen: 16 }] })), { ifname: 'eth0', addr_info: [{ family: 'inet', local: '192.168.65.3', prefixlen: 24 }] }]), stderr: '' };
    }
    if (command === 'iptables-save') return { code: 0, stdout: [...this.chains].map(([name, rules]) => `:${name} - [0:0]\n${rules.join('\n')}`).join('\n'), stderr: '' };
    if (command === 'iptables-restore') {
      if (this.failRestore) return { code: 1, stdout: '', stderr: 'injected atomic failure' };
      const next = new Map([...this.chains].map(([name, rules]) => [name, [...rules]]));
      for (const line of input!.split('\n')) {
        if (line.startsWith(':')) next.set(line.slice(1).split(' ')[0]!, []);
        if (line.startsWith('-N ')) { if (next.has(line.slice(3))) return { code: 1, stdout: '', stderr: 'chain exists' }; next.set(line.slice(3), []); }
        if (line.startsWith('-A ')) { const name = line.split(' ')[1]!; next.get(name)!.push(line); }
        if (line.startsWith('-F ')) next.set(line.slice(3), []);
        if (line.startsWith('-X ')) next.delete(line.slice(3));
      }
      this.chains = next;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('--version')) return { code: 0, stdout: 'iptables v1.8.11 (nf_tables)', stderr: '' };
    const op = args.findIndex(arg => ['-I', '-D', '-C'].includes(arg));
    if (op >= 0) {
      const operation = args[op], chain = args[op + 1]!, rule = `-A ${chain} ${args.slice(op + (operation === '-I' ? 3 : 2)).join(' ')}`;
      const rules = this.chains.get(chain)!;
      if (operation === '-I') rules.unshift(rule);
      else {
        const found = rules.indexOf(rule);
        if (found < 0) return { code: 1, stdout: '', stderr: 'rule absent' };
        if (operation === '-D') rules.splice(found, 1);
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error('unexpected command');
  }
}

test('firewall install atomically updates only its chain and keeps exact scoped hooks', async () => {
  const kernel = new Kernel(), firewall = new NetworkFirewall(kernel, 31555, owner);
  await firewall.install(descriptor, [descriptor]);
  assert.equal(firewall.ready(await firewall.snapshot(), descriptor, [descriptor]), true);
  const restore = kernel.calls.find(call => call.command === 'iptables-restore')!;
  assert.ok(restore.args.includes('--noflush'));
  assert.ok(!restore.input!.includes(':INPUT'));
  assert.ok(restore.input!.includes('-d 192.168.65.3/32 -m comment'), 'actual local interface addresses are protected');
  const hooksBefore = JSON.stringify([kernel.chains.get('INPUT'), kernel.chains.get('DOCKER-USER')]);
  const updated = { ...descriptor, allowedHostEndpoints: [{ address: '192.168.65.254', port: 4840, protocol: 'tcp' as const }] };
  await firewall.install(updated, [updated]);
  assert.equal(JSON.stringify([kernel.chains.get('INPUT'), kernel.chains.get('DOCKER-USER')]), hooksBefore);
  assert.equal(firewall.ready(await firewall.snapshot(), updated, [updated]), true);
  const protectedRules = [...kernel.chains.get(buildRuleSet(updated, 31555, owner).chain)!];
  kernel.failRestore = true;
  await assert.rejects(firewall.install(descriptor, [descriptor]));
  assert.deepEqual(kernel.chains.get(buildRuleSet(updated, 31555, owner).chain), protectedRules);
});

test('readiness requires real bridge, exact rule order and hooks before permissive rules', async () => {
  const kernel = new Kernel(), firewall = new NetworkFirewall(kernel, 31555, owner);
  await firewall.install(descriptor, [descriptor]);
  const own = buildRuleSet(descriptor, 31555, owner).chain;
  kernel.chains.get(own)!.unshift(`-A ${own} -j ACCEPT`);
  assert.equal(firewall.ready(await firewall.snapshot(), descriptor, [descriptor]), false);
  await assert.rejects(firewall.install(descriptor, [descriptor]), /归属|未知/);
  kernel.chains.get(own)!.shift();
  await firewall.install(descriptor, [descriptor]);
  kernel.chains.get('DOCKER-USER')!.unshift('-A DOCKER-USER -j ACCEPT');
  assert.equal(firewall.ready(await firewall.snapshot(), descriptor, [descriptor]), false);
  await firewall.install(descriptor, [descriptor]);
  assert.equal(firewall.ready(await firewall.snapshot(), descriptor, [descriptor]), true);
  kernel.missingBridge = true;
  assert.equal(firewall.ready(await firewall.snapshot(), descriptor, [descriptor]), false);
  const before = kernel.calls.filter(call => call.command === 'iptables-restore').length;
  await assert.rejects(firewall.install(descriptor, [descriptor]));
  assert.equal(kernel.calls.filter(call => call.command === 'iptables-restore').length, before);
});

test('unregister removes only exact own hooks and chain while preserving unrelated rules', async () => {
  const kernel = new Kernel(), firewall = new NetworkFirewall(kernel, 31555, owner);
  await firewall.install(descriptor, [descriptor]);
  await firewall.remove(descriptor);
  assert.deepEqual(kernel.chains.get('DOCKER-USER'), ['-A DOCKER-USER -i eth0 -j ACCEPT']);
  assert.deepEqual(kernel.chains.get('INPUT'), []);
  assert.equal(kernel.chains.has(buildRuleSet(descriptor, 31555, owner).chain), false);
  assert.ok(kernel.calls.every(call => !call.args.includes('-P')));
});

test('deterministic name alone never authorizes overwriting or deleting a foreign chain', async () => {
  const kernel = new Kernel(), firewall = new NetworkFirewall(kernel, 31555, owner), chain = buildRuleSet(descriptor, 31555, owner).chain;
  kernel.chains.set(chain, [`-A ${chain} -j DROP`]);
  const before = JSON.stringify([...kernel.chains]);
  await assert.rejects(firewall.install(descriptor, [descriptor]));
  await assert.rejects(firewall.remove(descriptor));
  assert.equal(JSON.stringify([...kernel.chains]), before);
  assert.equal(kernel.calls.filter(call => call.command === 'iptables-restore').length, 0);
});


test('independent domains coexist without hook contention but cannot claim the same network', async () => {
  const second = parseDescriptor({ ...descriptor, networkId: 'b'.repeat(64), cidr: '172.24.0.0/16', gateway: '172.24.0.1', bridge: 'br-bbbbbbbbbbbb', peerCIDRs: [descriptor.cidr] });
  const kernel = new Kernel(); kernel.descriptors = [descriptor, second];
  const first = new NetworkFirewall(kernel, 31555, owner), other = new NetworkFirewall(kernel, 31555, '2'.repeat(32));
  await first.install(descriptor, [descriptor]); await other.install(second, [second]);
  const operations = kernel.calls.filter(call => call.command === 'iptables-restore' || call.args.includes('-I')).length;
  for (let count = 0; count < 3; count++) {
    await first.install(descriptor, [descriptor]); await other.install(second, [second]);
    assert.equal(first.ready(await first.snapshot(), descriptor, [descriptor]), true);
    assert.equal(other.ready(await other.snapshot(), second, [second]), true);
  }
  assert.equal(kernel.calls.filter(call => call.command === 'iptables-restore' || call.args.includes('-I')).length, operations);
  const before = JSON.stringify([...kernel.chains]);
  await assert.rejects(other.install(descriptor, [descriptor])); await assert.rejects(other.remove(descriptor));
  assert.equal(JSON.stringify([...kernel.chains]), before);
  kernel.chains.get('DOCKER-USER')!.unshift('-A DOCKER-USER -m comment --comment "-i other-iface" -j ACCEPT');
  assert.equal(first.ready(await first.snapshot(), descriptor, [descriptor]), false, 'quoted comment cannot forge a nonmatching interface selector');
});
