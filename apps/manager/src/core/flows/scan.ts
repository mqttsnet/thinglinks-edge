/**
 * 模板里的内联凭据扫描（T4.6）。
 *
 * 实测 Node-RED 5.0.4：`GET /flows` **不会**带出 credentials（它们单独存在
 * 加密的 flows_cred.json 里），所以按规范声明的凭据是安全的。
 * 但 function 节点里硬编码的密钥会原样带出来 —— 模板最常见的用途就是
 * 跨项目分发，这种密钥会跟着传出去。
 *
 * **只告警不剥离**：剥离会把 function 的代码改坏，那比泄漏更难查。
 */
import { redact } from '../diag/redact.ts';
import { isAbsolute } from 'node:path/posix';
import type { FlowNode } from './types.ts';
type Literal = string | number;
type Lookup = (name: string) => Literal | undefined;
interface Token {
    text: string;
    kind: 'literal' | 'id' | 'punct';
    value?: Literal;
}
const SECRET_NAME = /^(?:password|passwd|pwd|secret|token|api_?key|access_?key|sign_?key|encrypt_?(?:key|vector)|(?:access|refresh|lease|auth)_?token|client_?secret|private_?key_?password|(?:master|private|secret)_?key|authorization)$/i;
const ENV_SECRET_NAME = /^[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z_]*$/;
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
function decodeLiteral(text: string): string | undefined {
    if (text[0] === '`' && text.includes('${'))
        return undefined;
    return text.slice(1, -1).replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|[\s\S])/gi, (_match, escape: string) => {
        if (/^u\{/.test(escape)) {
            const point = Number.parseInt(escape.slice(2, -1), 16);
            return point <= 0x10ffff ? String.fromCodePoint(point) : '';
        }
        if (/^[ux][0-9a-f]+$/i.test(escape))
            return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
        return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[escape] ?? escape;
    });
}
function literalTextHasSecret(value: string): boolean {
    return redact(value) !== value || /^\s*(?:Bearer|Basic)\s+\S/i.test(value)
        || /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(value);
}
function topIndexes(items: Token[], operators: string[]): number[] {
    const indexes: number[] = [];
    let depth = 0;
    items.forEach((token, i) => {
        if (OPEN.has(token.text))
            depth++;
        else if (CLOSE.has(token.text))
            depth--;
        else if (depth === 0 && operators.includes(token.text))
            indexes.push(i);
    });
    return indexes;
}
function unwrap(items: Token[]): Token[] {
    while (items[0]?.text === '(' && items.at(-1)?.text === ')') {
        let depth = 0, end = -1;
        for (let i = 0; i < items.length; i++) {
            if (items[i]!.text === '(')
                depth++;
            if (items[i]!.text === ')' && --depth === 0) {
                end = i;
                break;
            }
        }
        if (end !== items.length - 1)
            break;
        items = items.slice(1, -1);
    }
    return items;
}
function constant(input: Token[], lookup: Lookup, depth = 0): Literal | undefined {
    if (depth > 32)
        return undefined;
    const items = unwrap(input);
    if (items.length === 1)
        return items[0]!.kind === 'literal' ? items[0]!.value : lookup(items[0]!.text);
    if (items.length === 2 && items[0]!.text === '-' && typeof items[1]!.value === 'number')
        return -items[1]!.value;
    const plus = topIndexes(items, ['+']);
    if (plus.length) {
        const cuts = [-1, ...plus, items.length];
        let value: Literal | undefined;
        for (let i = 0; i < cuts.length - 1; i++) {
            const part = constant(items.slice(cuts[i]! + 1, cuts[i + 1]), lookup, depth + 1);
            if (part === undefined)
                return undefined;
            value = value === undefined ? part : typeof value === 'string' || typeof part === 'string' ? String(value) + String(part) : value + part;
        }
        return value;
    }
    if (items[0]?.text === 'String' && items[1]?.text === '(' && items.at(-1)?.text === ')') {
        const inner = constant(items.slice(2, -1), lookup, depth + 1);
        return inner === undefined ? undefined : String(inner);
    }
    return undefined;
}
function candidates(input: Token[], lookup: Lookup, depth = 0): Literal[] {
    if (depth > 32)
        return [];
    const items = unwrap(input), fixed = constant(items, lookup);
    if (fixed !== undefined)
        return [fixed];
    const fallback = topIndexes(items, ['||', '??']);
    if (fallback.length) {
        const cuts = [-1, ...fallback, items.length];
        return cuts.slice(0, -1).flatMap((at, i) => candidates(items.slice(at + 1, cuts[i + 1]), lookup, depth + 1));
    }
    const question = topIndexes(items, ['?'])[0];
    if (question !== undefined) {
        let nested = 0;
        for (const at of topIndexes(items.slice(question + 1), ['?', ':'])) {
            const absolute = at + question + 1;
            if (items[absolute]!.text === '?')
                nested++;
            else if (nested-- === 0)
                return [...candidates(items.slice(question + 1, absolute), lookup, depth + 1), ...candidates(items.slice(absolute + 1), lookup, depth + 1)];
        }
    }
    return [];
}
function expression(tokens: Token[], from: number): Token[] {
    let depth = 0, end = from;
    for (; end < tokens.length; end++) {
        const text = tokens[end]!.text;
        if (depth === 0 && (text === ';' || text === ',' || CLOSE.has(text)))
            break;
        if (OPEN.has(text))
            depth++;
        else if (CLOSE.has(text))
            depth--;
    }
    return tokens.slice(from, end);
}
function tokenize(source: string): {
    tokens: Token[];
    textHit: boolean;
} {
    const tokens: Token[] = [];
    const re = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?(?:e[+-]?\d+)?|===|!==|=>|==|!=|\|\|=|\?\?=|\|\||\?\?|&&|\?\.|[^\s]/gi;
    for (const match of source.matchAll(re)) {
        const text = match[0];
        if (text.startsWith('//') || text.startsWith('/*')) {
            if (redact(text) !== text)
                return { tokens, textHit: true };
            continue;
        }
        if (['"', "'", '`'].includes(text[0]!)) {
            const value = decodeLiteral(text);
            if (value !== undefined && literalTextHasSecret(value))
                return { tokens, textHit: true };
            tokens.push({ text, kind: 'literal', ...(value === undefined ? {} : { value }) });
        }
        else if (/^\d/.test(text))
            tokens.push({ text, kind: 'literal', value: Number(text) });
        else
            tokens.push({ text, kind: /^[A-Za-z_$]/.test(text) ? 'id' : 'punct' });
    }
    return { tokens, textHit: false };
}
/**
 * 提示性字面量扫描，不执行代码，不解析一般 JS 语义。
 * 复杂模板插值、任意函数返回和跨节点数据流仍需人工审查；没有告警不是安全证明。
 * 自定义与内置 Function 使用相同规则，不按节点名或来源跳过。
 */
function codeHasFixedSecret(source: string): boolean {
    const { tokens, textHit } = tokenize(source);
    if (textHit)
        return true;
    const scopes: Map<string, Literal>[] = [new Map()];
    const lookup = (name: string): Literal | undefined => {
        for (let i = scopes.length - 1; i >= 0; i--)
            if (scopes[i]!.has(name))
                return scopes[i]!.get(name);
        return undefined;
    };
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.text === '{') {
            scopes.push(new Map());
            continue;
        }
        if (token.text === '}') {
            if (scopes.length > 1)
                scopes.pop();
            continue;
        }
        const name = token.kind === 'literal' ? String(token.value ?? '') : token.text;
        const assignment = tokens[i + 1]?.text === ']' && tokens[i - 1]?.text === '[' ? i + 2 : i + 1;
        if (!['=', ':', '||=', '??='].includes(tokens[assignment]?.text ?? ''))
            continue;
        const value = expression(tokens, assignment + 1);
        if (tokens[i - 1]?.text === 'const' && token.kind === 'id') {
            const fixed = constant(value, lookup);
            if (fixed !== undefined)
                scopes.at(-1)!.set(name, fixed);
        }
        if (!SECRET_NAME.test(name) && !ENV_SECRET_NAME.test(name))
            continue;
        if (candidates(value, lookup).some(fixed => {
            const text = String(fixed).trim();
            return text !== '' && !(name.toLowerCase() === 'authorization' && /^(?:Bearer|Basic)$/i.test(text));
        }))
            return true;
    }
    return false;
}
/** Node-RED credentials are normally omitted, but imported JSON can still contain literal values. */
function fieldsHavePrivateKeyPassword(input: unknown): boolean {
    const pending: unknown[] = [input];
    while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== 'object') continue;
        for (const [key, child] of Object.entries(value)) {
            if (/^private_?key_?password$/i.test(key) && child !== undefined && child !== null && child !== ''
                && !(typeof child === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(child))) return true;
            if (child && typeof child === 'object') pending.push(child);
        }
    }
    return false;
}
/** Code is scanned as code; diagnostic log redaction is retained for ordinary node fields. */
export function scanInlineSecrets(flows: FlowNode[]): string[] {
    const hits: string[] = [];
    for (const n of flows) {
        const fields = { ...n };
        let codeHit = false;
        if (n.type === 'function')
            for (const key of ['func', 'initialize', 'finalize']) {
                if (typeof fields[key] === 'string')
                    codeHit ||= codeHasFixedSecret(fields[key]);
                delete fields[key];
            }
        const text = JSON.stringify(fields);
        const key = fields['privateKey'];
        const invalidKeyReference = n.type === 'tier0-opcua-connection' && key !== undefined && key !== ''
            && (typeof key !== 'string' || !isAbsolute(key) || /[\0\r\n]/.test(key));
        if (codeHit || invalidKeyReference || fieldsHavePrivateKeyPassword(fields) || literalTextHasSecret(text)) {
            const label = n.name || n.label || n.id;
            hits.push(`${n.type} 「${label}」`);
        }
    }
    return hits;
}
