import { isIP } from 'node:net';

function ipv4Range(cidr) {
  if (typeof cidr !== 'string') throw new TypeError('invalid CIDR');
  const parts = cidr.split('/');
  if (parts.length !== 2) throw new Error('invalid CIDR');
  const [address, prefixText] = parts;
  const family = isIP(address);
  const prefix = Number(prefixText);
  if (
    family === 0 || address.includes('%')
    || !/^(?:0|[1-9]\d{0,2})$/.test(prefixText)
    || prefix > (family === 4 ? 32 : 128)
  ) throw new Error('invalid CIDR');
  if (family === 6) return undefined;

  const numericAddress = address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(numericAddress / size) * size;
  return { start, end: start + size - 1 };
}

/** Choose only a verifier-owned /28; validate all input before selecting a candidate. */
export function chooseVerifierSubnet(occupiedCidrs) {
  if (!Array.isArray(occupiedCidrs)) throw new TypeError('occupiedCidrs must be an array of CIDRs');
  const occupied = [];
  for (const cidr of occupiedCidrs) {
    const range = ipv4Range(cidr);
    if (range) occupied.push(range);
  }
  for (let secondOctet = 219; secondOctet <= 253; secondOctet += 1) {
    const cidr = `10.${secondOctet}.255.240/28`;
    const candidate = ipv4Range(cidr);
    if (!occupied.some((range) => candidate.start <= range.end && range.start <= candidate.end)) {
      return cidr;
    }
  }
  throw new Error('no free verifier subnet in the configured candidate range');
}
