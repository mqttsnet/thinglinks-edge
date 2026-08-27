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
  // v3 —— 用户与权限：角色约束 + 实例授权矩阵（T4.4）
  `
  CREATE TABLE instance_grant (
    username    TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    level       TEXT NOT NULL CHECK (level IN ('view', 'operate')),
    granted_by  TEXT NOT NULL DEFAULT '',
    granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (username, instance_id),
    FOREIGN KEY (instance_id) REFERENCES instance(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_grant_user ON instance_grant(username);

  -- 停用而不是删除：删掉用户会让审计里的操作人失去指向
  ALTER TABLE app_user ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
  `,
  /*
   * v4 —— 云平台接入参数。
   *
   * 单行表（`id` 恒为 1）：一台边缘网关只接一个云平台租户。做成多行会引出
   * 「哪一行生效」的问题，而上行必须有唯一出口，否则断网缓存与微批就没有落点。
   *
   * 口令、signKey、encryptKey、encryptVector 一律**加密入库**，与实例凭据同一套
   * 主密钥派生。列名带 `_enc` 后缀是刻意的：看到敏感字段没这个后缀就知道写错了。
   */
  `
  CREATE TABLE cloud_config (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    enabled               INTEGER NOT NULL DEFAULT 0,
    broker_url            TEXT    NOT NULL,
    client_id             TEXT    NOT NULL,
    device_identification TEXT    NOT NULL,
    username              TEXT    NOT NULL DEFAULT '',
    password_enc          TEXT    NOT NULL DEFAULT '',
    cipher_flag           INTEGER NOT NULL DEFAULT 0,
    sign_key_enc          TEXT    NOT NULL DEFAULT '',
    encrypt_key_enc       TEXT    NOT NULL DEFAULT '',
    encrypt_vector_enc    TEXT    NOT NULL DEFAULT '',
    protocol_version      TEXT    NOT NULL DEFAULT 'v1',
    qos                   INTEGER NOT NULL DEFAULT 1 CHECK (qos IN (0, 1, 2)),
    updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_by            TEXT    NOT NULL DEFAULT ''
  );
  `,
  /*
   * v5 —— 云连接的 TLS 材料（mqtts / wss + 证书）。
   *
   * 只有**私钥**带 `_enc`：CA 与客户端证书是公开材料，明文存着排障时能直接看；
   * 私钥一旦泄漏，拿它就能冒充这台网关上行，与口令同级，必须加密。
   *
   * `tls_reject_unauthorized` 默认 1。默认值只能往严了给：默认放行的话，
   * 现场十有八九不会去改，于是全网的 TLS 都成了「只加密不认人」。
   */
  `
  ALTER TABLE cloud_config ADD COLUMN tls_mode                TEXT    NOT NULL DEFAULT 'system';
  ALTER TABLE cloud_config ADD COLUMN tls_ca                  TEXT    NOT NULL DEFAULT '';
  ALTER TABLE cloud_config ADD COLUMN tls_cert                TEXT    NOT NULL DEFAULT '';
  ALTER TABLE cloud_config ADD COLUMN tls_key_enc             TEXT    NOT NULL DEFAULT '';
  ALTER TABLE cloud_config ADD COLUMN tls_reject_unauthorized INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE cloud_config ADD COLUMN tls_servername          TEXT    NOT NULL DEFAULT '';
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
