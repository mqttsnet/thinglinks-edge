import { execFile } from 'node:child_process';
import { NetworkIsolationError, cidrParts, ipv4, type NetworkDescriptor } from './descriptor.ts';
import { buildRuleSet, canonicalRule, chainLines, ownerMarker, PARENT_CHAINS } from './rules.ts';

export type FirewallCommand = 'ip' | 'iptables' | 'iptables-save' | 'iptables-restore';
export class NetworkOwnershipError extends NetworkIsolationError {
  constructor() { super('同名防火墙链不属于当前控制域或含未知规则，拒绝覆盖', 409); this.name = 'NetworkOwnershipError'; }
}
export interface CommandResult { code: number; stdout: string; stderr: string }
export interface CommandRunner { run(command: FirewallCommand, args: readonly string[], input?: string): Promise<CommandResult> }
export function createCommandRunner(): CommandRunner {
  return { run: (command, args, input) => new Promise(resolve => {
    const child = execFile(command, [...args], { timeout: 5000, maxBuffer: 4 * 1024 ** 2,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  }) };
}
interface InterfaceInfo { bridge: boolean; addresses: Array<{ family: unknown; local: unknown; prefixlen: unknown; scope: unknown }> }
export interface KernelSnapshot { backendReady: boolean; interfaces: Map<string, InterfaceInfo>; localHosts: string[]; filter: string }
function rows(text: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > 4096 || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new NetworkIsolationError('宿主网络状态无法核验');
  return value as Record<string, unknown>[];
}

/** Only owns deterministic per-network chains and two precisely scoped parent jumps. */
export class NetworkFirewall {
  readonly runner: CommandRunner;
  readonly healthPort: number;
  readonly extraHosts: readonly string[];
  readonly ownerId: string;
  constructor(runner: CommandRunner, healthPort: number, ownerId: string, extraHosts: readonly string[] = []) {
    this.runner = runner; this.healthPort = healthPort; this.ownerId = ownerId; this.extraHosts = [...extraHosts];
    if (!/^[a-f0-9]{32}$/.test(ownerId)) throw new NetworkIsolationError('网络保护控制域无效', 400);
    if (!Number.isInteger(healthPort) || healthPort < 1024 || healthPort > 65535 || extraHosts.length > 128 || extraHosts.some(host => !ipv4(host))) throw new NetworkIsolationError('网络保护服务参数无效', 400);
  }
  private async command(command: FirewallCommand, args: readonly string[], input?: string): Promise<string> {
    const result = await this.runner.run(command, args, input);
    if (result.code !== 0) throw new NetworkIsolationError('宿主网络保护命令执行失败');
    return result.stdout;
  }
  async snapshot(): Promise<KernelSnapshot> {
    const version = await this.command('iptables', ['--version']);
    const links = rows(await this.command('ip', ['-d', '-j', 'link']));
    const addresses = rows(await this.command('ip', ['-j', 'address']));
    const filter = await this.command('iptables-save', ['-t', 'filter']);
    const interfaces = new Map<string, InterfaceInfo>(), localHosts = new Set(this.extraHosts);
    for (const link of links) {
      if (typeof link['ifname'] !== 'string') continue;
      const info = link['linkinfo'] as { info_kind?: unknown } | undefined;
      interfaces.set(link['ifname'], { bridge: info?.info_kind === 'bridge', addresses: [] });
    }
    for (const entry of addresses) {
      if (typeof entry['ifname'] !== 'string' || !Array.isArray(entry['addr_info'])) continue;
      for (const raw of entry['addr_info'] as Array<Record<string, unknown>>) {
        const address = { family: raw['family'], local: raw['local'], prefixlen: raw['prefixlen'], scope: raw['scope'] };
        interfaces.get(entry['ifname'])?.addresses.push(address);
        if (address.family === 'inet' && ipv4(address.local)) localHosts.add(address.local);
      }
    }
    const forward = chainLines(filter, 'FORWARD');
    return { backendReady: version.includes('(nf_tables)') && forward[0] === '-A FORWARD -j DOCKER-USER'
      && /^:DOCKER-USER /m.test(filter) && /^:INPUT /m.test(filter), interfaces, localHosts: [...localHosts].sort(), filter };
  }
  sourcePresent(snapshot: KernelSnapshot, descriptor: NetworkDescriptor): boolean { return snapshot.interfaces.has(descriptor.bridge); }
  bridgeMatches(snapshot: KernelSnapshot, descriptor: NetworkDescriptor): boolean {
    const current = snapshot.interfaces.get(descriptor.bridge), prefix = cidrParts(descriptor.cidr)?.prefix;
    return snapshot.backendReady && current?.bridge === true
      && current.addresses.some(address => address.family === 'inet' && address.local === descriptor.gateway && address.prefixlen === prefix)
      && !current.addresses.some(address => address.family === 'inet6' && address.scope !== 'link');
  }
  private hookFirst(snapshot: KernelSnapshot, parent: string, descriptor: NetworkDescriptor, known: readonly NetworkDescriptor[]): boolean {
    const own = canonicalRule(`-A ${parent} ${buildRuleSet(descriptor, this.healthPort, this.ownerId).hook.join(' ')}`);
    const owned = new Set(known.map(item => canonicalRule(`-A ${parent} ${buildRuleSet(item, this.healthPort, this.ownerId).hook.join(' ')}`)));
    for (const line of chainLines(snapshot.filter, parent)) {
      if (line === own) return true;
      if (owned.has(line)) continue;
      // Another deployment's exact ingress interface cannot match this network.
      // Do not infer selectors from quoted comments or wildcard/negated interfaces.
      const words: string[] = line.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? [];
      const ingress = words.indexOf('-i');
      if (ingress >= 0 && words[ingress - 1] !== '!' && words.filter(word => word === '-i').length === 1
        && /^[a-zA-Z0-9_.:-]{1,15}$/.test(words[ingress + 1] ?? '') && words[ingress + 1] !== descriptor.bridge) continue;
      return false;
    }
    return false;
  }
  ready(snapshot: KernelSnapshot, descriptor: NetworkDescriptor, known: readonly NetworkDescriptor[]): boolean {
    if (!this.bridgeMatches(snapshot, descriptor)) return false;
    const rules = buildRuleSet(descriptor, this.healthPort, this.ownerId, snapshot.localHosts);
    const actual = chainLines(snapshot.filter, rules.chain), expected = rules.rules.map(rule => canonicalRule(`-A ${rules.chain} ${rule.join(' ')}`));
    return actual.length === expected.length && actual.every((line, index) => line === expected[index])
      && PARENT_CHAINS.every(parent => this.hookFirst(snapshot, parent, descriptor, known));
  }
  assertOwnership(snapshot: KernelSnapshot, descriptor: NetworkDescriptor): void {
    const rules = buildRuleSet(descriptor, this.healthPort, this.ownerId), marker = ownerMarker(this.ownerId, descriptor.networkId);
    if (!snapshot.filter.split('\n').some(line => line.startsWith(`:${rules.chain} `))) return;
    const lines = chainLines(snapshot.filter, rules.chain);
    const valid = (line: string): boolean => {
      const tokens = line.split(' '), comment = tokens.indexOf('--comment');
      if (comment < 4 || tokens[comment - 2] !== '-m' || tokens[comment - 1] !== 'comment' || tokens[comment + 1] !== marker
        || tokens.filter(token => token === '--comment').length !== 1) return false;
      tokens.splice(comment - 2, 4);
      const rule = tokens.slice(2), text = rule.join(' ');
      if (text === '-j RETURN' || text === `-d ${descriptor.gateway} -p tcp -m tcp --dport ${this.healthPort} -j RETURN`
        || text === '-m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN') return true;
      if (rule.length === 4 && rule[0] === '-d' && rule[2] === '-j' && rule[3] === 'DROP') return !!cidrParts(rule[1]!.includes('/') ? rule[1]! : `${rule[1]}/32`);
      return rule.length === 10 && rule[0] === '-p' && ['tcp', 'udp'].includes(rule[1]!) && rule[2] === '-m' && rule[3] === 'conntrack'
        && rule[4] === '--ctorigdst' && ipv4(rule[5]) && rule[6] === '--ctorigdstport' && /^[1-9]\d{0,4}$/.test(rule[7]!) && Number(rule[7]) <= 65535
        && rule[8] === '-j' && rule[9] === 'RETURN';
    };
    if (!lines.length || lines.some(line => !valid(line))) throw new NetworkOwnershipError();
  }
  async install(descriptor: NetworkDescriptor, known: readonly NetworkDescriptor[]): Promise<void> {
    let snapshot = await this.snapshot();
    if (!this.bridgeMatches(snapshot, descriptor)) throw new NetworkIsolationError('实际宿主 bridge、网段或防火墙后端与注册内容不符');
    this.assertOwnership(snapshot, descriptor);
    if (this.ready(snapshot, descriptor, known)) return;
    const rules = buildRuleSet(descriptor, this.healthPort, this.ownerId, snapshot.localHosts);
    // --noflush preserves every undeclared chain. Declaring OUR chain replaces
    // its rules in the nft transaction; existing hooks stay attached throughout.
    const exists = snapshot.filter.split('\n').some(line => line.startsWith(`:${rules.chain} `));
    const program = exists ? rules.restore : rules.restore.replace(`:${rules.chain} - [0:0]`, `-N ${rules.chain}`);
    try { await this.command('iptables-restore', ['--noflush', '--wait', '5'], program); }
    catch (error) { this.assertOwnership(await this.snapshot(), descriptor); throw error; }
    snapshot = await this.snapshot();
    for (const parent of PARENT_CHAINS) {
      if (!this.hookFirst(snapshot, parent, descriptor, known)) {
        // Insert before a misplaced old duplicate; never remove protection first.
        await this.command('iptables', ['-w', '5', '-I', parent, '1', ...rules.hook]);
      }
    }
    if (!this.ready(await this.snapshot(), descriptor, known)) throw new NetworkIsolationError('网络保护规则读回未通过');
  }
  async remove(descriptor: NetworkDescriptor): Promise<void> {
    const rules = buildRuleSet(descriptor, this.healthPort, this.ownerId);
    this.assertOwnership(await this.snapshot(), descriptor);
    for (const parent of PARENT_CHAINS) {
      for (let count = 0; count < 32; count++) {
        const exists = await this.runner.run('iptables', ['-w', '5', '-C', parent, ...rules.hook]);
        if (exists.code === 1) break;
        if (exists.code !== 0 || count === 31) throw new NetworkIsolationError('无法安全移除本网络的入口规则');
        await this.command('iptables', ['-w', '5', '-D', parent, ...rules.hook]);
      }
    }
    const snapshot = await this.snapshot();
    if (snapshot.filter.split('\n').some(line => line.startsWith(`:${rules.chain} `))) {
      await this.command('iptables-restore', ['--noflush', '--wait', '5'], `*filter\n-F ${rules.chain}\n-X ${rules.chain}\nCOMMIT\n`);
    }
    const after = await this.snapshot();
    if (after.filter.split('\n').some(line => line.startsWith(`:${rules.chain} `) || line.endsWith(`-j ${rules.chain}`))) throw new NetworkIsolationError('网络保护清理未完成');
  }
}
