/**
 * 现场设备台账与点位表。
 *
 * 数据来源是**实例里的 `@thinglinks` 节点主动回报**，不是解析 flows.json 反推
 * （`06-功能可行性审视.md` 第 2 节：方案 A 脆弱，只能尽力探测；方案 B 才是可信台账）。
 *
 * 因此这里的内容**天然不完整**：用户用原生 modbus/opcua 节点采的那部分，
 * 平台看不见。界面上必须如实标注「未纳管」，不能让用户以为看到的是全部 ——
 * 06 号文把这条定为诚信问题。
 *
 * 只存**当前值**，不存时序。历史数据在云端 TDengine，边缘不做 historian。
 */
import type { Db } from '../db.ts';

export interface FieldDeviceInput {
  nodeId: string;
  name: string;
  protocol?: string;
  address?: string;
  model?: string;
  manufacturer?: string;
}

export interface FieldDeviceRecord {
  instanceId: string;
  nodeId: string;
  name: string;
  protocol: string;
  address: string;
  model: string;
  manufacturer: string;
  online: boolean;
  lastSeen: string | null;
  registeredAt: string;
}

export interface FieldTagInput {
  nodeId: string;
  tagId: string;
  name?: string;
  unit?: string;
  dataType?: string;
}

export interface FieldTagRecord {
  instanceId: string;
  nodeId: string;
  tagId: string;
  name: string;
  unit: string;
  dataType: string;
  /** 最近一次上报的值，已还原为原始类型；从未上报过时为 null */
  lastValue: unknown;
  quality: string;
  lastAt: string | null;
}

export interface TagValueInput {
  nodeId: string;
  tagId: string;
  value: unknown;
  /** 质量码，留空按 good 处理 */
  quality?: string;
  /** 采集时刻，ISO 串；留空用当前时间 */
  at?: string;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

const nowIso = () => new Date().toISOString();

function assertId(value: string, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RegistryError(`${what} 不能为空`);
  }
  if (value.length > 128) throw new RegistryError(`${what} 过长（上限 128）：${value.slice(0, 32)}…`);
  return value;
}

export class FieldRegistry {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** 注册或更新一台现场设备。重复注册是幂等的 —— flow 重启会重放注册 */
  upsertDevice(instanceId: string, d: FieldDeviceInput): void {
    assertId(instanceId, 'instanceId');
    assertId(d.nodeId, 'nodeId');
    this.db.prepare(
      `INSERT INTO field_device (instance_id, node_id, name, protocol, address, model, manufacturer)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance_id, node_id) DO UPDATE SET
         name = excluded.name, protocol = excluded.protocol, address = excluded.address,
         model = excluded.model, manufacturer = excluded.manufacturer`,
    ).run(instanceId, d.nodeId, d.name ?? d.nodeId, d.protocol ?? '', d.address ?? '',
          d.model ?? '', d.manufacturer ?? '');
  }

  setDeviceOnline(instanceId: string, nodeId: string, online: boolean): void {
    this.db.prepare(
      'UPDATE field_device SET online = ?, last_seen = ? WHERE instance_id = ? AND node_id = ?',
    ).run(online ? 1 : 0, nowIso(), instanceId, nodeId);
  }

  /** 定义一个点位。同样幂等 */
  upsertTag(instanceId: string, t: FieldTagInput): void {
    assertId(instanceId, 'instanceId');
    assertId(t.nodeId, 'nodeId');
    assertId(t.tagId, 'tagId');
    this.db.prepare(
      `INSERT INTO field_tag (instance_id, node_id, tag_id, name, unit, data_type)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance_id, node_id, tag_id) DO UPDATE SET
         name = excluded.name, unit = excluded.unit, data_type = excluded.data_type`,
    ).run(instanceId, t.nodeId, t.tagId, t.name ?? t.tagId, t.unit ?? '', t.dataType ?? '');
  }

  /**
   * 记录点位当前值。
   *
   * 值以 JSON 串落库，读出时还原 —— 数值、布尔、字符串、对象都能原样回来，
   * 存成 TEXT 再猜类型会把 `"1"` 和 `1` 弄混。
   *
   * 未定义过的点位会**自动补一条定义**：现场常见先有值后补元数据，
   * 丢掉这类值会让界面出现「有设备没点位」的空洞。
   */
  recordValues(instanceId: string, values: TagValueInput[]): number {
    assertId(instanceId, 'instanceId');
    const upsertTag = this.db.prepare(
      `INSERT INTO field_tag (instance_id, node_id, tag_id) VALUES (?, ?, ?)
       ON CONFLICT(instance_id, node_id, tag_id) DO NOTHING`,
    );
    const setValue = this.db.prepare(
      `UPDATE field_tag SET last_value = ?, quality = ?, last_at = ?
       WHERE instance_id = ? AND node_id = ? AND tag_id = ?`,
    );
    const touchDevice = this.db.prepare(
      'UPDATE field_device SET online = 1, last_seen = ? WHERE instance_id = ? AND node_id = ?',
    );

    const run = this.db.transaction((items: TagValueInput[]) => {
      for (const v of items) {
        assertId(v.nodeId, 'nodeId');
        assertId(v.tagId, 'tagId');
        const at = v.at ?? nowIso();
        upsertTag.run(instanceId, v.nodeId, v.tagId);
        setValue.run(JSON.stringify(v.value ?? null), v.quality ?? 'good', at,
                     instanceId, v.nodeId, v.tagId);
        // 有值上来说明设备是活的
        touchDevice.run(at, instanceId, v.nodeId);
      }
      return items.length;
    });
    return run(values);
  }

  devices(instanceId?: string): FieldDeviceRecord[] {
    const rows = instanceId
      ? this.db.prepare('SELECT * FROM field_device WHERE instance_id = ? ORDER BY node_id').all(instanceId)
      : this.db.prepare('SELECT * FROM field_device ORDER BY instance_id, node_id').all();
    return (rows as Record<string, unknown>[]).map((r) => ({
      instanceId: String(r['instance_id']),
      nodeId: String(r['node_id']),
      name: String(r['name']),
      protocol: String(r['protocol']),
      address: String(r['address']),
      model: String(r['model']),
      manufacturer: String(r['manufacturer']),
      online: Number(r['online']) === 1,
      lastSeen: (r['last_seen'] as string | null) ?? null,
      registeredAt: String(r['registered_at']),
    }));
  }

  tags(instanceId?: string, nodeId?: string): FieldTagRecord[] {
    const where: string[] = [];
    const args: string[] = [];
    if (instanceId) { where.push('instance_id = ?'); args.push(instanceId); }
    if (nodeId) { where.push('node_id = ?'); args.push(nodeId); }
    const sql = `SELECT * FROM field_tag${where.length ? ' WHERE ' + where.join(' AND ') : ''}`
      + ' ORDER BY node_id, tag_id';
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map((r) => ({
      instanceId: String(r['instance_id']),
      nodeId: String(r['node_id']),
      tagId: String(r['tag_id']),
      name: String(r['name']),
      unit: String(r['unit']),
      dataType: String(r['data_type']),
      lastValue: r['last_value'] === null || r['last_value'] === undefined
        ? null : JSON.parse(String(r['last_value'])),
      quality: String(r['quality']),
      lastAt: (r['last_at'] as string | null) ?? null,
    }));
  }

  /** 总览用。注意这些数字只涵盖已纳管的部分 */
  summary(instanceId?: string): { devices: number; online: number; tags: number } {
    const d = this.devices(instanceId);
    return {
      devices: d.length,
      online: d.filter((x) => x.online).length,
      tags: this.tags(instanceId).length,
    };
  }
}
