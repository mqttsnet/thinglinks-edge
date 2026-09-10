import type { Db } from '../../db.ts';
import { ownedDevices, successfulDevices } from './results.ts';
import { withDeadline } from './deadline.ts';

export type PresenceState = 'ONLINE' | 'OFFLINE';
export interface PresenceCloud {
  status(): { state: string; deviceIdentification: string };
  onStateChange(handler: () => void): () => void;
  querySubDevices(deviceIds: string[], expectedGatewayId: string, signal?: AbortSignal): Promise<unknown>;
  updateSubDeviceStatus(statuses: { deviceId: string; status: PresenceState }[], expectedGatewayId: string, signal?: AbortSignal): Promise<unknown>;
}
interface Source { online: boolean | undefined }
interface Device {
  sources: Map<string, Source>;
  revision: number;
  confirmed: PresenceState | undefined;
  confirmedAt: number;
  nextAttemptAt: number;
  failures: number;
  observed: number;
  confirmedObserved: number;
  sourcesDirty: boolean;
  offlineBlocked: boolean;
}
interface Snapshot { id: string; device: Device; revision: number; status: PresenceState; observed: number }
interface Options {
  db: Db;
  cloud: PresenceCloud;
  listInstances(signal: AbortSignal): Promise<{ id: string; running: boolean }[]>;
  now?: () => number;
  onError?: (message: string) => void;
  /** Polling only detects actual container stop/removal; it is not a device-silence timeout. */
  intervalMs?: number;
  instanceTimeoutMs?: number;
}
const MAX_SOURCES = 10_000;
const REFRESH_MS = 5 * 60_000;
const MAX_BATCH = 100;

/**
 * Live-ingest presence, separate from durable telemetry replay. Cloud ownership is checked before
 * each bounded status batch. This client check does not replace authorization in the Cloud server.
 */
export class PresenceSynchronizer {
  readonly #o: Options;
  readonly #now: () => number;
  #gatewayId = '';
  #devices = new Map<string, Device>();
  #sources = 0;
  #epoch = 0;
  #closed = false;
  #timer: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;
  #round: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #lastError = '';

  constructor(options: Options) { this.#o = options; this.#now = options.now ?? Date.now; }

  start(): void {
    if (this.#closed || this.#timer) return;
    this.#unsubscribe = this.#o.cloud.onStateChange(() => {
      this.#epoch++; this.#abort?.abort();
      this.#selectGateway();
      for (const device of this.#devices.values()) {
        device.confirmed = undefined;
        device.nextAttemptAt = 0;
        // Broker reconnect is not new device evidence. Quiet sources stay unknown until live ingest.
        for (const source of device.sources.values()) if (source.online === true) source.online = undefined;
        device.revision++;
      }
    });
    this.#timer = setInterval(() => { void this.runOnce(); }, this.#o.intervalMs ?? 5_000);
    this.#timer.unref();
    void this.runOnce();
  }

  /** Called only after authenticated, validated live uplink has been recorded locally. */
  observeUplink(instanceId: string, deviceId: string): void { this.#observe(instanceId, deviceId, true); }

  /** Explicit false only. A registration or status:true is not proof of live data. */
  observeOffline(instanceId: string, deviceId: string): void { this.#observe(instanceId, deviceId, false); }

  #observe(instanceId: string, deviceId: string, online: boolean): void {
    if (this.#closed) return;
    this.#selectGateway();
    if (!this.#gatewayId || !instanceId || !deviceId || deviceId === '_gateway' || deviceId === this.#gatewayId) return;
    let device = this.#devices.get(deviceId);
    if (!device) {
      if (this.#sources >= MAX_SOURCES) { this.#error('子设备状态同步候选达到上限；采集继续，新增状态尚未同步'); return; }
      device = this.#newDevice();
      this.#devices.set(deviceId, device);
    }
    let source = device.sources.get(instanceId);
    if (!source) {
      if (this.#sources >= MAX_SOURCES) { this.#markConflict(deviceId, device); this.#error('子设备状态同步来源达到上限；该设备离线状态需人工核对'); return; }
      source = { online: undefined }; device.sources.set(instanceId, source); this.#sources++;
      device.sourcesDirty = true;
    }
    if (online) device.observed++;
    if (source.online !== online) {
      const before = this.#desired(device);
      source.online = online;
      device.revision++;
      // An additional active source does not require another Cloud action log entry.
      if (before !== this.#desired(device)) device.nextAttemptAt = 0;
    }
  }

  runOnce(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#round) return this.#round;
    this.#abort = new AbortController();
    this.#round = this.#run(this.#abort.signal).catch(() => { this.#error('子设备状态同步未完成，等待下一轮重试'); }).finally(() => { this.#round = undefined; this.#abort = undefined; });
    return this.#round;
  }

  async close(): Promise<void> {
    this.#closed = true; this.#epoch++; this.#abort?.abort();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.(); this.#unsubscribe = undefined;
    // Cancel transport waits and await the owned round; no timer or late state mutation survives close.
    await this.#round;
  }

  #newDevice(): Device {
    return { sources: new Map(), revision: 0, confirmed: undefined, confirmedAt: 0, nextAttemptAt: 0, failures: 0, observed: 0, confirmedObserved: 0, sourcesDirty: false, offlineBlocked: false };
  }

  #selectGateway(): void {
    const gatewayId = this.#o.cloud.status().deviceIdentification;
    if (gatewayId === this.#gatewayId) return;
    this.#gatewayId = gatewayId; this.#epoch++;
    this.#devices.clear(); this.#sources = 0;
    if (!gatewayId) return;
    const rows = this.#o.db.prepare('SELECT instance_id, device_id, source_conflict FROM cloud_presence WHERE gateway_id = ? LIMIT ?')
      .all(gatewayId, MAX_SOURCES) as { instance_id: string; device_id: string; source_conflict: number }[];
    for (const row of rows) {
      let device = this.#devices.get(row.device_id);
      if (!device) { device = this.#newDevice(); this.#devices.set(row.device_id, device); }
      // A running instance after Manager restart is unknown until fresh live ingestion.
      device.sources.set(row.instance_id, { online: undefined }); this.#sources++;
      if (row.source_conflict) { device.offlineBlocked = true; this.#error('存在未完整跟踪的设备来源；该设备离线状态需人工核对'); }
    }
  }

  #desired(device: Device): PresenceState | undefined {
    const values = [...device.sources.values()].map(source => source.online);
    if (values.includes(true)) return 'ONLINE';
    return !device.offlineBlocked && values.length > 0 && values.every(value => value === false) ? 'OFFLINE' : undefined;
  }

  async #reconcileInstances(epoch: number, signal: AbortSignal): Promise<boolean> {
    let instances: { id: string; running: boolean }[];
    try { instances = await withDeadline(current => this.#o.listInstances(current), signal, this.#o.instanceTimeoutMs ?? 3_000); }
    catch { this.#error('无法核对实例运行状态，本轮不推送子设备状态'); return false; }
    if (this.#closed || epoch !== this.#epoch) return false;
    const running = new Set(instances.filter(instance => instance.running).map(instance => instance.id));
    for (const device of this.#devices.values()) {
      for (const [id, source] of device.sources) {
        if (!running.has(id) && source.online !== false) {
          source.online = false; device.revision++; device.nextAttemptAt = 0;
        }
      }
    }
    return true;
  }

  #current(epoch: number, batch: Snapshot[]): Snapshot[] {
    if (this.#closed || epoch !== this.#epoch || this.#o.cloud.status().state !== 'online') return [];
    return batch.filter(item => this.#devices.get(item.id) === item.device && item.revision === item.device.revision && this.#desired(item.device) === item.status);
  }

  async #run(signal: AbortSignal): Promise<void> {
    this.#selectGateway();
    const epoch = this.#epoch;
    if (!this.#gatewayId || !(await this.#reconcileInstances(epoch, signal)) || this.#o.cloud.status().state !== 'online') return;
    const now = this.#now();
    const candidates: Snapshot[] = [];
    for (const [id, device] of this.#devices) {
      const status = this.#desired(device);
      if (status && now >= device.nextAttemptAt && (device.sourcesDirty || device.confirmed !== status || (status === 'ONLINE' && device.observed > device.confirmedObserved && now - device.confirmedAt >= REFRESH_MS))) {
        candidates.push({ id, device, revision: device.revision, status, observed: device.observed });
      }
    }
    candidates.sort((a, b) => Number(a.device.confirmed === a.status) - Number(b.device.confirmed === b.status));
    const batch = candidates.slice(0, MAX_BATCH);
    if (!batch.length) return;
    const gatewayId = this.#gatewayId;
    let valid: Snapshot[] = [];
    try {
      const owned = ownedDevices(await this.#o.cloud.querySubDevices(batch.map(item => item.id), gatewayId, signal), batch.map(item => item.id), gatewayId);
      if (!(await this.#reconcileInstances(epoch, signal))) return;
      const current = this.#current(epoch, batch);
      const denied = current.filter(item => !owned.has(item.id));
      if (denied.length) this.#backoff(denied, '子设备归属未确认：响应缺失、失败、重复或不属于当前网关');
      valid = current.filter(item => owned.has(item.id));
      if (!valid.length) return;
      const needsStatusUpdate = (item: Snapshot) => item.device.confirmed !== item.status
        || (item.status === 'ONLINE' && item.observed > item.device.confirmedObserved && now - item.device.confirmedAt >= REFRESH_MS);
      // Source ownership needs persistence even when an old OFFLINE needs no Cloud status refresh.
      for (const item of valid.filter(item => !needsStatusUpdate(item))) {
        if (this.#persist(gatewayId, item) === 'stored') item.device.sourcesDirty = false;
        else this.#backoff([item], '子设备状态来源达到上限；保持待核对并退避重试');
      }
      valid = valid.filter(needsStatusUpdate);
      // Retain correction responsibility before any Cloud side effect, including a lost response/crash.
      valid = valid.filter(item => {
        const retained = this.#persist(gatewayId, item, false);
        if (retained !== 'stored') this.#backoff([item], '子设备状态来源达到上限；保持待核对并退避重试');
        return retained !== 'missing';
      });
      valid = this.#current(epoch, valid);
      if (!valid.length) return;
      // The request may change Cloud even when its response is lost or superseded. A former
      // confirmation must not suppress the compensating update after a local state round trip.
      for (const item of valid) item.device.confirmed = undefined;
      const response = await this.#o.cloud.updateSubDeviceStatus(valid.map(item => ({ deviceId: item.id, status: item.status })), gatewayId, signal);
      const succeeded = successfulDevices(response, valid.map(item => item.id));
      if (!(await this.#reconcileInstances(epoch, signal))) return;
      const remaining = this.#current(epoch, valid);
      this.#backoff(remaining.filter(item => !succeeded.has(item.id)), '云端子设备状态存在逐项失败或缺失，尚未确认同步');
      for (const item of remaining.filter(item => succeeded.has(item.id))) {
        const retained = this.#persist(gatewayId, item);
        item.device.confirmed = item.status; item.device.confirmedAt = now;
        item.device.confirmedObserved = item.observed;
        item.device.sourcesDirty = retained !== 'stored';
        if (retained === 'stored') { item.device.failures = 0; item.device.nextAttemptAt = 0; }
        else this.#backoff([item], '子设备状态来源达到上限；保持待核对并退避重试');
      }
    } catch {
      this.#backoff(this.#current(epoch, valid.length ? valid : batch), '云端子设备状态请求或响应校验失败，等待退避重试');
    }
  }

  #markConflict(deviceId: string, device: Device): void {
    device.offlineBlocked = true;
    // This update needs no extra row, even when old gateways occupy the entire persistence budget.
    this.#o.db.prepare('UPDATE cloud_presence SET source_conflict = 1 WHERE gateway_id = ? AND device_id = ?')
      .run(this.#gatewayId, deviceId);
  }

  #persist(gatewayId: string, item: Snapshot, confirmed = true): 'stored' | 'guarded' | 'missing' {
    const sources = [...item.device.sources].filter(([, source]) => source.online !== undefined);
    return this.#o.db.transaction(() => {
      const existing = this.#o.db.prepare('SELECT 1 FROM cloud_presence WHERE gateway_id = ? AND instance_id = ? AND device_id = ?');
      const needed = sources.filter(([id]) => !existing.get(gatewayId, id, item.id)).length;
      const total = (this.#o.db.prepare('SELECT count(*) n FROM cloud_presence').get() as { n: number }).n;
      if (total + needed > MAX_SOURCES) {
        this.#markConflict(item.id, item.device);
        this.#error('子设备状态持久化达到上限；该设备离线状态需人工核对，采集继续');
        // A retained conflict guard still permits an evidenced ONLINE; it prevents restart from
        // inferring OFFLINE from the incomplete source list. No row means no state side effect.
        const retained = this.#o.db.prepare('UPDATE cloud_presence SET confirmed_status = ? WHERE gateway_id = ? AND device_id = ?')
          .run(confirmed ? item.status : null, gatewayId, item.id).changes;
        return retained ? 'guarded' : 'missing';
      }
      const upsert = this.#o.db.prepare(`INSERT INTO cloud_presence (gateway_id, instance_id, device_id, confirmed_status, source_conflict)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (gateway_id, instance_id, device_id) DO UPDATE SET confirmed_status = excluded.confirmed_status, source_conflict = MAX(source_conflict, excluded.source_conflict)`);
      for (const [id] of sources) upsert.run(gatewayId, id, item.id, confirmed ? item.status : null, item.device.offlineBlocked ? 1 : 0);
      return 'stored';
    })();
  }

  #backoff(items: Snapshot[], message: string): void {
    if (!items.length) return;
    for (const item of items) {
      item.device.failures = Math.min(item.device.failures + 1, 7);
      item.device.nextAttemptAt = this.#now() + Math.min(300_000, 5_000 * 2 ** (item.device.failures - 1));
    }
    this.#error(message);
  }
  #error(message: string): void {
    if (message !== this.#lastError) this.#o.onError?.(message);
    this.#lastError = message;
  }
}
