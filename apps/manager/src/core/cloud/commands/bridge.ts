import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../../db.ts';
import type { DownlinkCommand } from '../gateway.ts';
import { midKey, normalizeMid } from '../mid.ts';
import { validateModelCommand } from './model-validation.ts';
import { COMMAND_SCHEMA } from './schema.ts';
import { validateBinding, validateDownlink, validatePoll, validateResult } from './validation.ts';
import { CommandError, type CommandCloud, type CommandLimits, type CommandRecord, type CommandStatus, type LeasedCommand } from './types.ts';
const DEFAULT_LIMITS: CommandLimits = { maxPending: 1000, maxResults: 1000, maxBindings: 1000, maxGateways: 32, bindingTtlMs: 60000, queueMs: 60000, leaseMs: 30000 };
interface Row {
    id: string;
    gateway_id: string;
    mid: string;
    instance_id: string;
    consumer_id: string;
    device_id: string;
    service_code: string;
    cmd: string;
    params_json: string;
    product_id: string;
    version_no: string;
    model_checked: number;
    status: CommandStatus;
    result_json: string | null;
    error: string;
    created_at: number;
    completed_at: number | null;
    queue_deadline: number;
    lease_deadline: number | null;
    lease_hash: string;
    reply_pending: number;
    reply_attempts: number;
    reply_error: string;
}
interface Binding {
    instance_id: string;
    consumer_id: string;
    node_id: string;
    service_code: string;
    commands_json: string;
    last_seen: number;
}
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const toRecord = (row: Row): CommandRecord => ({ id: row.id, mid: normalizeMid(row.mid), gatewayId: row.gateway_id, instanceId: row.instance_id, consumerId: row.consumer_id, deviceIdentification: row.device_id, serviceCode: row.service_code, cmd: row.cmd, params: JSON.parse(row.params_json), status: row.status, result: row.result_json ? JSON.parse(row.result_json) : null, error: row.error, createdAt: new Date(row.created_at).toISOString(), completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(), replyPending: row.reply_pending === 1, replyAttempts: row.reply_attempts, replyError: row.reply_error, modelChecked: row.model_checked === 1 });
/** Durable at-most-once dispatch. Only receipts are retried; uncertain device actions are never re-leased. */
export class CommandBridge {
    readonly #db: Db;
    readonly #cloud: CommandCloud;
    readonly #now: () => number;
    readonly #limits: CommandLimits;
    #timer: NodeJS.Timeout | undefined;
    #unsubscribers: (() => void)[] = [];
    #flushing: Promise<void> | undefined;
    constructor(options: {
        db: Db;
        cloud: CommandCloud;
        now?: () => number;
        limits?: Partial<CommandLimits>;
    }) {
        this.#db = options.db;
        this.#cloud = options.cloud;
        this.#now = options.now ?? Date.now;
        this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
        for (const value of Object.values(this.#limits))
            if (!Number.isSafeInteger(value) || value < 1)
                throw new CommandError('命令队列限制必须是正整数');
        this.#db.exec(COMMAND_SCHEMA);
    }
    start(): void {
        if (this.#timer)
            return;
        this.#unsubscribers = [this.#cloud.onCommand(command => { void this.receive(command).catch(() => { }); }), this.#cloud.onStateChange(state => { if (state === 'online')
                void this.tick().catch(() => { }); })];
        this.#timer = setInterval(() => { void this.tick().catch(() => { }); }, 1000);
        this.#timer.unref();
    }
    async close(): Promise<void> { if (this.#timer)
        clearInterval(this.#timer); this.#timer = undefined; for (const unsubscribe of this.#unsubscribers)
        unsubscribe(); this.#unsubscribers = []; await this.#flushing; }
    registerBindings(instanceId: string, input: unknown): {
        accepted: number;
    } {
        const binding = validateBinding(input), now = this.#now();
        this.#db.transaction(() => {
            this.#db.prepare('DELETE FROM cloud_command_binding WHERE last_seen < ?').run(now - this.#limits.bindingTtlMs);
            const exists = this.#db.prepare('SELECT 1 FROM cloud_command_binding WHERE instance_id=? AND consumer_id=? AND node_id=? AND service_code=?').get(instanceId, binding.consumerId, binding.nodeId, binding.serviceCode);
            if (!exists && this.#count('cloud_command_binding') >= this.#limits.maxBindings)
                throw new CommandError('命令绑定数量超过上限', 503);
            this.#db.prepare(`INSERT INTO cloud_command_binding(instance_id,consumer_id,node_id,service_code,commands_json,last_seen) VALUES (?,?,?,?,?,?)
    ON CONFLICT(instance_id,consumer_id,node_id,service_code) DO UPDATE SET commands_json=excluded.commands_json,last_seen=excluded.last_seen`)
                .run(instanceId, binding.consumerId, binding.nodeId, binding.serviceCode, JSON.stringify(binding.commands), now);
        })();
        return { accepted: binding.commands.length };
    }
    async receive(command: DownlinkCommand): Promise<void> {
        const body = validateDownlink(command), now = this.#now();
        const mid=midKey(command.mid);
        let retired = false;
        this.#db.transaction(() => {
            this.#expire();
            const existing = this.#db.prepare('SELECT * FROM cloud_command WHERE gateway_id=? AND device_id=? AND mid=?').get(command.gatewayId, body.deviceId, mid) as Row | undefined;
            if (existing) {
                if (existing.completed_at !== null)
                    this.#db.prepare('UPDATE cloud_command SET reply_pending=1 WHERE id=?').run(existing.id);
                return;
            }
            let ledger = this.#db.prepare('SELECT retired_mid FROM cloud_command_gateway WHERE gateway_id=?').get(command.gatewayId) as {
                retired_mid: string;
            } | undefined;
            if (!ledger) {
                if (this.#count('cloud_command_gateway') >= this.#limits.maxGateways)
                    throw new CommandError('网关去重账本数量超过上限', 503);
                this.#db.prepare('INSERT INTO cloud_command_gateway(gateway_id) VALUES (?)').run(command.gatewayId);
                ledger = { retired_mid: '0' };
            }
            if (BigInt(mid) <= BigInt(ledger.retired_mid)) {
                retired = true;
                return;
            }
            const targets = this.#targets(body.deviceId, body.serviceCode, body.cmd);
            let error = targets.length === 0 ? '没有活跃的已声明命令目标' : targets.length > 1 ? '存在多个活跃命令消费者，目标不明确' : '';
            const binding = targets.length === 1 ? targets[0] : undefined;
            if (binding) {
                const declaration = (JSON.parse(binding.commands_json) as {
                    cmd: string;
                    param: string;
                }[]).find(item => item.cmd === body.cmd)!;
                const names = Object.keys(body.params);
                if (names.length !== 1 || names[0] !== declaration.param)
                    error = '命令参数与声明不符，未声明参数不会被部分执行';
            }
            const model = body.productIdentification && body.versionNo
                ? this.#cloud.getCachedModel?.(body.productIdentification, body.versionNo) : undefined;
            let modelChecked = false;
            if (!error && model) {
                modelChecked = true;
                error = validateModelCommand(model, body.serviceCode, body.cmd, body.params).join('；');
            }
            if (!error && this.#count('cloud_command', "status IN ('queued','leased')") >= this.#limits.maxPending)
                error = '命令等待队列已满，未执行';
            this.#db.prepare(`INSERT INTO cloud_command(id,gateway_id,mid,instance_id,consumer_id,device_id,service_code,cmd,params_json,status,error,created_at,completed_at,queue_deadline,reply_pending,product_id,version_no,model_checked)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), command.gatewayId, mid, binding?.instance_id ?? '', binding?.consumer_id ?? '', body.deviceId, body.serviceCode, body.cmd, JSON.stringify(body.params), error ? 'rejected' : 'queued', error, now, error ? now : null, now + this.#limits.queueMs, error ? 1 : 0, body.productIdentification, body.versionNo, modelChecked ? 1 : 0);
            this.#prune();
        })();
        if (retired) {
            // Bounded retention is not perpetual exact deduplication. Older unseen mids fail closed.
            await this.#cloud.publishCommandResponse(command.mid, { deviceIdentification: body.deviceId, msgType: 'deviceRsp', serviceCode: body.serviceCode, cmd: body.cmd, errCode: 1, params: {}, errMsg: 'mid已超出去重结果保留窗口，拒绝重新执行' }, command.gatewayId).catch(() => { });
        }
        await this.#flushReplies();
    }
    next(instanceId: string, input: unknown): LeasedCommand | null {
        const poll = validatePoll(input);
        return this.#db.transaction(() => {
            this.#expire();
            const binding = this.#db.prepare('SELECT * FROM cloud_command_binding WHERE instance_id=? AND consumer_id=? AND node_id=? AND service_code=?').get(instanceId, poll.consumerId, poll.nodeId, poll.serviceCode) as Binding | undefined;
            if (!binding)
                throw new CommandError('消费者尚未登记命令绑定', 409);
            this.#db.prepare('UPDATE cloud_command_binding SET last_seen=? WHERE instance_id=? AND consumer_id=? AND node_id=? AND service_code=?').run(this.#now(), instanceId, poll.consumerId, poll.nodeId, poll.serviceCode);
            const gatewayId = this.#cloud.status().deviceIdentification;
            if (this.#db.prepare("SELECT 1 FROM cloud_command WHERE device_id=? AND service_code=? AND status='leased'").get(poll.nodeId, poll.serviceCode))
                return null;
            const candidates = this.#db.prepare("SELECT * FROM cloud_command WHERE gateway_id=? AND instance_id=? AND consumer_id=? AND device_id=? AND service_code=? AND status='queued' ORDER BY created_at,rowid LIMIT 1").get(gatewayId, instanceId, poll.consumerId, poll.nodeId, poll.serviceCode) as Row | undefined;
            if (!candidates)
                return null;
            const targets = this.#targets(candidates.device_id, candidates.service_code, candidates.cmd);
            if (targets.length !== 1 || targets[0]?.instance_id !== instanceId || targets[0]?.consumer_id !== poll.consumerId) {
                this.#terminal(candidates, 'rejected', '消费者绑定失效或出现多个活跃目标');
                return null;
            }
            const declaration = (JSON.parse(targets[0].commands_json) as {
                cmd: string;
                param: string;
            }[]).find(item => item.cmd === candidates.cmd);
            if (!declaration || Object.keys(JSON.parse(candidates.params_json))[0] !== declaration.param) {
                this.#terminal(candidates, 'rejected', '命令绑定在执行前发生变化');
                return null;
            }
            const model = candidates.product_id && candidates.version_no
                ? this.#cloud.getCachedModel?.(candidates.product_id, candidates.version_no) : undefined;
            if (model) {
                const issues = validateModelCommand(model, candidates.service_code, candidates.cmd, JSON.parse(candidates.params_json));
                this.#db.prepare('UPDATE cloud_command SET model_checked=1 WHERE id=?').run(candidates.id);
                if (issues.length) { this.#terminal(candidates, 'rejected', issues.join('；')); return null; }
            }
            const leaseToken = randomUUID();
            const leaseDeadline = this.#now() + this.#limits.leaseMs;
            this.#db.prepare("UPDATE cloud_command SET status='leased',lease_hash=?,lease_deadline=? WHERE id=? AND status='queued'").run(digest(leaseToken), leaseDeadline, candidates.id);
            return { id: candidates.id, leaseToken, leaseDeadline, mid: normalizeMid(candidates.mid), deviceIdentification: candidates.device_id, serviceCode: candidates.service_code, cmd: candidates.cmd, params: JSON.parse(candidates.params_json) };
        })();
    }
    async complete(instanceId: string, id: string, input: unknown): Promise<CommandRecord> {
        const result = validateResult(input);
        this.#db.transaction(() => { this.#expire(); this.#prune(); })();
        const row = this.#db.transaction(() => {
            const current = this.#db.prepare('SELECT * FROM cloud_command WHERE id=?').get(id) as Row | undefined;
            if (!current || current.instance_id !== instanceId)
                throw new CommandError('命令不属于当前实例', 403);
            if (current.lease_hash !== digest(result.leaseToken))
                throw new CommandError('命令租约令牌无效', 403);
            if (current.status === 'unknown')
                throw new CommandError('命令租约已超时，执行结果未知；不会自动重执行', 409);
            if (current.status !== 'leased') {
                if (current.status === 'succeeded' || current.status === 'failed')
                    return current;
                throw new CommandError('命令尚未发给执行器', 409);
            }
            this.#terminal(current, result.ok ? 'succeeded' : result.unknown ? 'unknown' : 'failed', result.ok ? '' : result.error || '执行器报告失败', result.result ?? {});
            const completed = this.#db.prepare('SELECT * FROM cloud_command WHERE id=?').get(id) as Row;
            this.#prune();
            return completed;
        })();
        await this.#flushReplies();
        return toRecord((this.#db.prepare('SELECT * FROM cloud_command WHERE id=?').get(id) as Row | undefined) ?? row);
    }
    list(instanceId?: string): CommandRecord[] {
        const rows = (instanceId === undefined ? this.#db.prepare('SELECT * FROM cloud_command ORDER BY created_at DESC,rowid DESC').all() : this.#db.prepare('SELECT * FROM cloud_command WHERE instance_id=? ORDER BY created_at DESC,rowid DESC').all(instanceId)) as Row[];
        return rows.map(toRecord);
    }
    async tick(): Promise<void> { this.#db.transaction(() => { this.#expire(); this.#prune(); })(); await this.#flushReplies(); }
    #count(table: string, where = '1=1'): number { return (this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as {
        n: number;
    }).n; }
    #targets(device: string, service: string, cmd: string): Binding[] { return (this.#db.prepare('SELECT * FROM cloud_command_binding WHERE node_id=? AND service_code=? AND last_seen>=?').all(device, service, this.#now() - this.#limits.bindingTtlMs) as Binding[]).filter(binding => (JSON.parse(binding.commands_json) as {
        cmd: string;
    }[]).some(item => item.cmd === cmd)); }
    #terminal(row: Row, status: CommandStatus, error: string, result: unknown = null): void { this.#db.prepare('UPDATE cloud_command SET status=?,error=?,result_json=?,completed_at=?,reply_pending=1 WHERE id=?').run(status, error, result === null ? null : JSON.stringify(result), this.#now(), row.id); }
    #expire(): void {
        for (const row of this.#db.prepare("SELECT * FROM cloud_command WHERE status='queued' AND queue_deadline<=? OR status='leased' AND lease_deadline<=?").all(this.#now(), this.#now()) as Row[]) {
            this.#terminal(row, row.status === 'leased' ? 'unknown' : 'failed', row.status === 'leased' ? '执行租约超时，设备执行结果未知，禁止自动重试' : '等待执行器超时，命令未发给执行器');
        }
    }
    #prune(): void {
        const excess = this.#count('cloud_command', 'completed_at IS NOT NULL') - this.#limits.maxResults;
        if (excess <= 0)
            return;
        for (const row of this.#db.prepare('SELECT * FROM cloud_command WHERE completed_at IS NOT NULL ORDER BY completed_at,rowid LIMIT ?').all(excess) as Row[]) {
            const retired=this.#db.prepare('SELECT retired_mid FROM cloud_command_gateway WHERE gateway_id=?').get(row.gateway_id) as {retired_mid:string};
            if(BigInt(row.mid)>BigInt(retired.retired_mid)) {
                this.#db.prepare('UPDATE cloud_command_gateway SET retired_mid=? WHERE gateway_id=?').run(row.mid,row.gateway_id);
            }
            this.#db.prepare('DELETE FROM cloud_command WHERE id=?').run(row.id);
        }
    }
    #flushReplies(): Promise<void> {
        if (this.#flushing)
            return this.#flushing;
        this.#flushing = this.#sendReplies().finally(() => { this.#flushing = undefined; });
        return this.#flushing;
    }
    async #sendReplies(): Promise<void> {
        const gateway = this.#cloud.status().deviceIdentification;
        if (!gateway)
            return;
        const rows = this.#db.prepare('SELECT * FROM cloud_command WHERE gateway_id=? AND reply_pending=1 ORDER BY completed_at LIMIT 64').all(gateway) as Row[];
        for (const row of rows) {
            this.#db.prepare('UPDATE cloud_command SET reply_attempts=reply_attempts+1 WHERE id=?').run(row.id);
            try {
                await this.#cloud.publishCommandResponse(normalizeMid(row.mid), { deviceIdentification: row.device_id, msgType: 'deviceRsp', serviceCode: row.service_code, cmd: row.cmd, errCode: row.status === 'succeeded' ? 0 : 1, params: row.result_json ? JSON.parse(row.result_json) : {}, errMsg: row.error }, row.gateway_id);
                this.#db.prepare("UPDATE cloud_command SET reply_pending=0,reply_error='' WHERE id=?").run(row.id);
            }
            catch (error) {
                this.#db.prepare('UPDATE cloud_command SET reply_error=? WHERE id=?').run((error as Error).message.slice(0, 512), row.id);
                break;
            }
        }
    }
}
