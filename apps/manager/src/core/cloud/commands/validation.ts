import { CommandError, type CommandBindingInput, type CommandPoll, type CommandResultInput } from './types.ts';
import type { DownlinkCommand } from '../gateway.ts';
import { normalizeMid } from '../mid.ts';
const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);
export function object(value: unknown, label = '参数'): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new CommandError(`${label}必须是对象`);
    return value as Record<string, unknown>;
}
export function code(value: unknown, label: string): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,127}$/.test(value) || BLOCKED.has(value))
        throw new CommandError(`${label}格式无效`);
    return value;
}
function keys(value: Record<string, unknown>, allowed: string[]) { for (const key of Object.keys(value))
    if (BLOCKED.has(key) || !allowed.includes(key))
        throw new CommandError(`未声明字段：${key}`); }
export function boundedJson(value: unknown, max = 65536): string {
    let text: string | undefined;
    try {
        text = JSON.stringify(value);
    }
    catch {
        throw new CommandError('数据不是有效JSON');
    }
    if (text === undefined || Buffer.byteLength(text) > max)
        throw new CommandError('数据大小超过上限');
    return text;
}
export function validatePoll(value: unknown): CommandPoll {
    const b = object(value);
    keys(b, ['consumerId', 'nodeId', 'serviceCode']);
    return { consumerId: code(b.consumerId, 'consumerId'), nodeId: code(b.nodeId, 'nodeId'), serviceCode: code(b.serviceCode, 'serviceCode') };
}
export function validateBinding(value: unknown): CommandBindingInput {
    const b = object(value);
    keys(b, ['consumerId', 'nodeId', 'serviceCode', 'commands']);
    const poll = validatePoll({ consumerId: b.consumerId, nodeId: b.nodeId, serviceCode: b.serviceCode });
    if (!Array.isArray(b.commands) || b.commands.length < 1 || b.commands.length > 64)
        throw new CommandError('commands需要1至64项');
    const seen = new Set<string>();
    const commands = b.commands.map(raw => { const item = object(raw); keys(item, ['cmd', 'param']); const cmd = code(item.cmd, 'cmd'), param = code(item.param, 'param'); if (seen.has(cmd))
        throw new CommandError('命令映射重复'); seen.add(cmd); return { cmd, param }; });
    return { ...poll, commands };
}
export function validateDownlink(command: DownlinkCommand) {
    try { normalizeMid(command.mid); } catch { throw new CommandError('mid必须是精确的正Long整数'); }
    code(command.gatewayId, 'gatewayId');
    boundedJson(command.body);
    const b = object(command.body, '命令');
    keys(b, ['deviceIdentification', 'productIdentification', 'msgType', 'serviceCode', 'cmd', 'params', 'versionNo']);
    if (b.msgType !== 'cloudReq')
        throw new CommandError('命令msgType必须是cloudReq');
    if (b.productIdentification !== undefined)
        code(b.productIdentification, 'productIdentification');
    if (b.versionNo !== undefined)
        code(b.versionNo, 'versionNo');
    const params = object(b.params, 'params');
    for (const [key, value] of Object.entries(params)) {
        code(key, '命令参数');
        if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)))
            throw new CommandError('命令参数必须是安全标量');
        if (typeof value === 'string' && value.length > 2048)
            throw new CommandError('命令参数长度超过上限');
    }
    return { deviceId: code(b.deviceIdentification, 'deviceIdentification'), serviceCode: code(b.serviceCode, 'serviceCode'), cmd: code(b.cmd, 'cmd'), params, productIdentification: typeof b.productIdentification === 'string' ? b.productIdentification : '', versionNo: typeof b.versionNo === 'string' ? b.versionNo : '' };
}
export function validateResult(value: unknown): CommandResultInput {
    const b = object(value);
    keys(b, ['leaseToken', 'ok', 'unknown', 'result', 'error']);
    if(b.unknown!==undefined&&(typeof b.unknown!=='boolean'||(b.unknown&&b.ok===true)))throw new CommandError('unknown仅可用于未确认执行结果');
    if (typeof b.leaseToken !== 'string' || b.leaseToken.length < 16 || b.leaseToken.length > 128)
        throw new CommandError('租约令牌格式无效');
    if (typeof b.ok !== 'boolean')
        throw new CommandError('ok必须是布尔值');
    if (b.error !== undefined && (typeof b.error !== 'string' || b.error.length > 1024))
        throw new CommandError('error必须是1024字符内文本');
    let result: Record<string, unknown> | undefined;
    if (b.result !== undefined) {
        result = object(b.result, 'result');
        boundedJson(result);
    }
    return { leaseToken: b.leaseToken, ok: b.ok, ...(b.unknown===true?{unknown:true}:{}), ...(result === undefined ? {} : { result }), ...(b.error === undefined ? {} : { error: b.error as string }) };
}
