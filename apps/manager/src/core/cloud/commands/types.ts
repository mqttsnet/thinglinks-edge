import type { ProductModel } from '../model-client.ts';
import type { DownlinkCommand } from '../gateway.ts';
import type { CloudState } from '../runtime.ts';
import type { ProtocolMid } from '../mid.ts';
export interface CommandBindingInput {
    consumerId: string;
    nodeId: string;
    serviceCode: string;
    commands: {
        cmd: string;
        param: string;
    }[];
}
export interface CommandPoll {
    consumerId: string;
    nodeId: string;
    serviceCode: string;
}
export interface CommandResultInput {
    leaseToken: string;
    ok: boolean;
    unknown?: boolean;
    result?: Record<string, unknown>;
    error?: string;
}
export interface LeasedCommand {
    id: string;
    leaseToken: string;
    /** Absolute Manager deadline in epoch milliseconds; consumers must not renew it locally. */
    leaseDeadline: number;
    mid: ProtocolMid;
    deviceIdentification: string;
    serviceCode: string;
    cmd: string;
    params: Record<string, unknown>;
}
export type CommandStatus = 'queued' | 'leased' | 'succeeded' | 'failed' | 'rejected' | 'unknown';
export interface CommandRecord {
    id: string;
    mid: ProtocolMid;
    gatewayId: string;
    instanceId: string;
    consumerId: string;
    deviceIdentification: string;
    serviceCode: string;
    cmd: string;
    params: Record<string, unknown>;
    status: CommandStatus;
    result: Record<string, unknown> | null;
    error: string;
    createdAt: string;
    completedAt: string | null;
    replyPending: boolean;
    replyAttempts: number;
    replyError: string;
    modelChecked: boolean;
}
export interface CommandCloud {
    status(): {
        deviceIdentification: string;
    };
    onCommand(handler: (command: DownlinkCommand) => void): () => void;
    onStateChange(handler: (state: CloudState) => void): () => void;
    getCachedModel?(productIdentification: string, versionNo: string): ProductModel | undefined;
    publishCommandResponse(mid: ProtocolMid, body: unknown, expectedGatewayId?: string): Promise<void>;
}
export interface CommandLimits {
    maxPending: number;
    maxResults: number;
    maxBindings: number;
    maxGateways: number;
    bindingTtlMs: number;
    queueMs: number;
    leaseMs: number;
}
export class CommandError extends Error {
    readonly status: number;
    constructor(message: string, status = 400) { super(message); this.name = 'CommandError'; this.status = status; }
}
