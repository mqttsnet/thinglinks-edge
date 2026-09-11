/** Internal MID representation. Large Java Long values must never pass through Number. */
export type ProtocolMid = number | string;
const MAX_LONG = 9223372036854775807n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const invalid = () => new Error('mid必须是1至9223372036854775807范围内的精确十进制整数');

export function normalizeMid(value: unknown): ProtocolMid {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw invalid();
    return value;
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) throw invalid();
  const integer = BigInt(value);
  if (integer > MAX_LONG) throw invalid();
  return integer <= MAX_SAFE ? Number(value) : value;
}

export function midKey(value: ProtocolMid): string { return String(normalizeMid(value)); }

/**
 * Extract only root head.mid after JSON.parse has accepted the full document.
 * This is a non-recursive token skipper, not a replacement JSON parser; strings
 * and nested business data are skipped without converting their numeric values.
 * It works at the supported Node 22.18 floor without JSON.rawJSON/reviver context.
 */
export function midFromValidatedEnvelopeJson(text: string): ProtocolMid {
  const space = (from: number) => { let i=from; while (/^[\x20\t\r\n]$/.test(text[i] ?? '')) i++; return i; };
  const stringEnd = (from: number): number => {
    if (text[from] !== '"') throw invalid();
    for (let i=from+1;i<text.length;i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return i+1;
    }
    throw invalid();
  };
  const valueEnd = (from: number): number => {
    if (text[from] === '"') return stringEnd(from);
    if (text[from] === '{' || text[from] === '[') {
      let depth=1;
      for(let i=from+1;i<text.length;i++) {
        const char=text[i];
        if(char==='"') i=stringEnd(i)-1;
        else if(char==='{' || char==='[') depth++;
        else if((char==='}' || char===']') && --depth===0) return i+1;
      }
      throw invalid();
    }
    let i=from;
    while(i<text.length && !/[\x20\t\r\n,}\]]/.test(text[i]!)) i++;
    return i;
  };
  const field = (from: number, name: string): {start:number;end:number} => {
    if(text[from] !== '{') throw invalid();
    let found: {start:number;end:number}|undefined;
    let i=space(from+1);
    while(i<text.length && text[i]!=='}') {
      const keyEnd=stringEnd(i), key=JSON.parse(text.slice(i,keyEnd)) as string;
      i=space(keyEnd);
      if(text[i]!==':') throw invalid();
      const start=space(i+1),end=valueEnd(start);
      if(key===name) { if(found) throw invalid(); found={start,end}; }
      i=space(end);
      if(text[i]==='}') break;
      if(text[i]!==',') throw invalid();
      i=space(i+1);
    }
    if(!found) throw invalid();
    return found;
  };
  const head=field(space(0),'head');
  const mid=field(head.start,'mid');
  // Quotes, exponent notation and fractional tokens intentionally fail this canonical integer rule.
  return normalizeMid(text.slice(mid.start,mid.end));
}
