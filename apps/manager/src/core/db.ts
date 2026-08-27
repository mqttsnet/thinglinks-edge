/**
 * SQLite —— 只承担平台元数据。
 *
 * 明确不承担：断网期间的消息缓存。那部分是纯顺序写读加整段删除，
 * 用不到 SQL，且 SQLite 单写者加每事务 fsync 扛不住高频写入，
 * 将来用 append-only 分段日志（见 08 文档）。两者职责分离。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

/** 迁移只增不改：已发布的语句不得修改，变更一律追加新版本 */
const MIGRATIONS: string[] = [
  // v1 —— Node-RED 多实例所需的最小集合
  `
  CREATE TABLE app_user (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE,
    pwd_hash        TEXT NOT NULL,
    pwd_salt        TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'admin',
    must_change_pwd INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE instance (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    image_tag   TEXT NOT NULL,
    mem_limit   INTEGER NOT NULL,
    cpu_limit   REAL NOT NULL,
    admin_root  TEXT NOT NULL,
    cred_secret TEXT NOT NULL,
    notes       TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- pwd_enc 是可逆加密而非哈希：免密跳转需要取明文换 access_token
  CREATE TABLE instance_cred (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL REFERENCES instance(id) ON DELETE CASCADE,
    username    TEXT NOT NULL,
    pwd_enc     TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '*',
    UNIQUE (instance_id, username)
  );

  CREATE TABLE port_map (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id    TEXT NOT NULL REFERENCES instance(id) ON DELETE CASCADE,
    host_port      INTEGER NOT NULL UNIQUE,
    container_port INTEGER NOT NULL,
    protocol       TEXT NOT NULL DEFAULT 'tcp',
    host_ip        TEXT NOT NULL DEFAULT '127.0.0.1',
    purpose        TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE audit (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL,
    ts     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_audit_ts ON audit(ts);
  `,
  // v2 —— 现场设备台账与点位表（`@thinglinks` 节点集回报的结构化信息）
  `
  ALTER TABLE instance ADD COLUMN ingest_token_enc TEXT NOT NULL DEFAULT '';

  CREATE TABLE field_device (
    instance_id   TEXT NOT NULL,
    node_id       TEXT NOT NULL,
    name          TEXT NOT NULL,
    protocol      TEXT NOT NULL DEFAULT '',
    address       TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    manufacturer  TEXT NOT NULL DEFAULT '',
    online        INTEGER NOT NULL DEFAULT 0,
    last_seen     TEXT,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (instance_id, node_id),
    FOREIGN KEY (instance_id) REFERENCES instance(id) ON DELETE CASCADE
  );

  CREATE TABLE field_tag (
    instance_id TEXT NOT NULL,
    node_id     TEXT NOT NULL,
    tag_id      TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    unit        TEXT NOT NULL DEFAULT '',
    data_type   TEXT NOT NULL DEFAULT '',
    last_value  TEXT,
    quality     TEXT NOT NULL DEFAULT '',
    last_at     TEXT,
    PRIMARY KEY (instance_id, node_id, tag_id),
    FOREIGN KEY (instance_id) REFERENCES instance(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_field_tag_instance ON field_tag(instance_id);
  `,
];

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  let current = row?.version ?? 0;
  if (row === undefined) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();

  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v];
    if (sql === undefined) continue;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('UPDATE schema_version SET version = ?').run(v + 1);
    })();
    current = v + 1;
  }
  return current;
}

export function recordAudit(
  db: Db,
  entry: { actor: string; action: string; target?: string; detail?: string; result: string },
): void {
  db.prepare(
    'INSERT INTO audit (actor, action, target, detail, result) VALUES (?, ?, ?, ?, ?)',
  ).run(entry.actor, entry.action, entry.target ?? '', entry.detail ?? '', entry.result);
}
