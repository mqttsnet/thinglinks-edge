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
  /*
   * v6 —— 流程模板（T4.6）。
   *
   * 存的是 Node-RED 的 flows JSON 原文。**不含凭据**：实测 5.0.4 的
   * `GET /flows` 不返回 credentials（它们单独存在加密的 flows_cred.json 里）。
   * 但 function 节点里硬编码的密钥会原样带出来，所以导出时扫一遍存进 `warnings`，
   * 让共享模板的人在分发前就知道有这回事。
   *
   * `node_types` 是套用前的护栏：模板用了目标实例没装的节点，套上去会得到
   * 一堆坏节点而且不会报错。存下来就能在套用前当场比对。
   */
  `
  CREATE TABLE flow_template (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL,
    node_count  INTEGER NOT NULL DEFAULT 0,
    tab_count   INTEGER NOT NULL DEFAULT 0,
    node_types  TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT '',
    warnings    TEXT NOT NULL DEFAULT '[]',
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_template_created ON flow_template(created_at);
  `,
  /*
   * v7 —— MQTT 连接参数（版本、心跳、超时、重连）。
   *
   * 在此之前这几项写死在 gateway 里。写死的问题不是不能用，是**现场没得调**：
   * 有些云侧只认 MQTT 3.1.1；NAT 网关常在 60 秒后回收空闲连接，心跳得压到 30；
   * 4G 弱网现场重连间隔 5 秒会把本就窄的带宽打满。这些都不该靠改代码解决。
   *
   * 每一个默认值都**等于改动前写死的那个值**，所以已装的现场升上来行为不变 ——
   * 升级顺手改掉运行参数是最难排查的一类事故。
   *
   * 注意 `mqtt_version` 与既有的 `protocol_version` 是两回事：前者是 MQTT 协议本身
   * （3/4/5，即 3.1 / 3.1.1 / 5.0），后者是 topic 首段的 `v1`。名字挨着但一个都不能混。
   */
  `
  ALTER TABLE cloud_config ADD COLUMN mqtt_version        INTEGER NOT NULL DEFAULT 5;
  ALTER TABLE cloud_config ADD COLUMN keepalive_sec       INTEGER NOT NULL DEFAULT 60;
  ALTER TABLE cloud_config ADD COLUMN connect_timeout_sec INTEGER NOT NULL DEFAULT 15;
  ALTER TABLE cloud_config ADD COLUMN auto_reconnect      INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE cloud_config ADD COLUMN reconnect_period_ms INTEGER NOT NULL DEFAULT 5000;
  `,
  /*
   * v8 —— 系统设置与两步验证。
   *
   * `system_setting` 是单行表（`id` 恒为 1），只装**运行期可改**的那几项。
   * 部署期的东西（EXTERNAL_URL、MASTER_KEY、数据根、缓存写满策略）**刻意不放进来**：
   * 从 Web 改 EXTERNAL_URL 能把自己锁在外面，改写满策略是替客户做数据取舍。
   * 那些留在 compose 里，改动有文件、有版本、有人 review。
   *
   * 默认值同样等于改动前写死在代码里的常量，升上来行为不变。
   *
   * 两步验证的密钥与实例凭据、云端 signKey 同一套主密钥加密入库（`_enc` 后缀）。
   * `totp_last_step` 存上次用过的时间步：TOTP 一个码有 30 秒有效期，
   * 中间人截到之后在窗口内重放是能成功的，只接受更大的步数才堵得住。
   *
   * 恢复码单独一张表而不是塞进 app_user 的一个 JSON 列：用掉一条要标记 used_at，
   * 塞在 JSON 里就得读出来改完再写回去，并发下会互相覆盖。
   */
  `
  CREATE TABLE system_setting (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    session_idle_min     INTEGER NOT NULL DEFAULT 480,
    login_max_failures   INTEGER NOT NULL DEFAULT 5,
    login_lock_min       INTEGER NOT NULL DEFAULT 5,
    require_2fa          INTEGER NOT NULL DEFAULT 0,
    update_check_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at           TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_by           TEXT    NOT NULL DEFAULT ''
  );
  INSERT INTO system_setting (id) VALUES (1);

  ALTER TABLE app_user ADD COLUMN totp_secret_enc TEXT    NOT NULL DEFAULT '';
  ALTER TABLE app_user ADD COLUMN totp_enabled    INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE app_user ADD COLUMN totp_last_step  INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE recovery_code (
    username  TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    used_at   TEXT,
    PRIMARY KEY (username, code_hash)
  );
  CREATE INDEX idx_recovery_user ON recovery_code(username);
  `,
  /*
   * v9 —— 断网记录（08 号文第 8 节）。
   *
   * 现场问「昨晚断了多久、丢没丢、补完没有」时，光靠当前状态答不上来 ——
   * 那时候链路早恢复了，指标也归零了。所以每次断网留一条，**跨重启留存**。
   *
   * 一次断网有三个时刻，不是两个：断开、链路恢复、积压补完。
   * 中间那段是「连上了但还在追欠账」，现场最关心的恰恰是它 ——
   * 只记断开和恢复，会让人以为一恢复就没事了。
   */
  `
  CREATE TABLE cloud_outage (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   TEXT    NOT NULL,
    restored_at  TEXT,
    drained_at   TEXT,
    peak_pending INTEGER NOT NULL DEFAULT 0,
    spooled      INTEGER NOT NULL DEFAULT 0,
    replayed     INTEGER NOT NULL DEFAULT 0,
    dropped      INTEGER NOT NULL DEFAULT 0,
    status       TEXT    NOT NULL DEFAULT 'ongoing'
                 CHECK (status IN ('ongoing', 'restoring', 'done')),
    note         TEXT    NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_outage_started ON cloud_outage(started_at DESC);
  `,
  /*
   * v10 —— 节点白名单（01 号文 5.7）。
   *
   * 只存**审批结果**，不存包体 —— 包体在 <dataDir>/npm 下，由 NodeStore 管。
   * 两者刻意分开：审批是管理动作要留痕（谁批的、什么时候、为什么），
   * 而包体是几十 MB 的二进制，塞进 SQLite 只会让备份变慢、WAL 变大。
   *
   * version 空串表示不限版本。用空串而不是 NULL，是为了让主键与查询
   * 都不必处理三值逻辑 —— 这张表的语义里没有「未知版本」这回事。
   */
  `
  CREATE TABLE node_catalog (
    module      TEXT PRIMARY KEY,
    version     TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  /*
   * v11 —— 点位历史（断网期间现场也要能看趋势）。
   *
   * **上限用条数而不是保留天数**：边缘盒子的硬约束是磁盘容量与 SD 卡写入量，
   * 而条数直接对应这两者，天数不对应 —— 同样保留 7 天，10 个点位和 500 个点位
   * 差着两个数量级。按条数封顶，最坏情况可预期。
   * 代价是「能看多久」随点位数量浮动，所以接口要如实回报最早一条的时间，
   * 界面据此说「只有最近 X 起的数据」，而不是让人以为看到的是全部。
   *
   * **只建一条索引**：每多一条索引，每次写入就多一份放大。查询只有一种形状
   * （某个点位按时间倒序取一段），一条复合索引就够。
   *
   * hist_at 记在 field_tag 上，用来判断「这个点位上次存历史是什么时候」——
   * 放在这里而不是去查历史表，是为了避免每次写入都扫一次历史。
   */
  `
  CREATE TABLE field_value_history (
    instance_id TEXT NOT NULL,
    node_id     TEXT NOT NULL,
    tag_id      TEXT NOT NULL,
    at          TEXT NOT NULL,
    value       TEXT,
    quality     TEXT NOT NULL DEFAULT 'good',
    FOREIGN KEY (instance_id) REFERENCES instance(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_fvh_series ON field_value_history(instance_id, node_id, tag_id, at DESC);
  ALTER TABLE field_tag ADD COLUMN hist_at TEXT;
  `,
  /*
   * v12 —— 节点源（01 号文 5.7）。
   *
   * 源的增删改必须在页面上完成，不能每次都改编排文件重启 ——
   * 现场加一个内网私服是常规运维动作，不是一次发布。
   * 环境变量 EDGE_NPM_UPSTREAM 退化成**全新安装时的初始值**，之后以库为准。
   */
  `
  CREATE TABLE npm_source (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    url        TEXT    NOT NULL UNIQUE,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    created_by TEXT    NOT NULL DEFAULT ''
  );
  `,
  /*
   * v13 —— Node-RED 平台节点运行模式与可恢复迁移日志。
   *
   * instance 上的状态只是列表/UI 投影；instance_node_migration 才是崩溃恢复依据。
   * 两者的每次推进必须在同一事务中完成，启动时发现不一致就转人工处理，不能猜。
   */
  `
  ALTER TABLE instance ADD COLUMN node_runtime_mode TEXT NOT NULL DEFAULT 'legacy'
    CHECK (node_runtime_mode IN ('legacy', 'npm'));
  ALTER TABLE instance ADD COLUMN platform_node_version TEXT NOT NULL DEFAULT '';
  ALTER TABLE instance ADD COLUMN node_migration_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (node_migration_state IN (
      'idle','preparing','checkpointed','staged','cutover','verifying',
      'pending_start_verification','rolling_back','committed',
      'rolled_back','rolled_back_dirty','manual_required'
    ));
  ALTER TABLE instance ADD COLUMN node_migration_error TEXT NOT NULL DEFAULT 'none'
    CHECK (node_migration_error IN (
      'none','preflight','checkpoint','install','cutover','verification',
      'rollback','compensation','state-inconsistent'
    ));

  CREATE TABLE instance_node_migration (
    instance_id TEXT PRIMARY KEY REFERENCES instance(id) ON DELETE CASCADE,
    tx_id TEXT NOT NULL UNIQUE,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('bootstrap','migration')),
    phase TEXT NOT NULL CHECK (phase IN (
      'preparing','checkpointed','staged','cutover','verifying',
      'pending_start_verification','rolling_back','committed',
      'rolled_back','rolled_back_dirty','manual_required'
    )),
    original_running INTEGER NOT NULL CHECK (original_running IN (0,1)),
    staged_before INTEGER NOT NULL CHECK (staged_before IN (0,1)),
    mode_before TEXT NOT NULL,
    image_id_before TEXT NOT NULL,
    target_integrity TEXT NOT NULL,
    checkpoint_dir TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    actor TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    error TEXT NOT NULL DEFAULT 'none' CHECK (error IN (
      'none','preflight','checkpoint','install','cutover','verification',
      'rollback','compensation','state-inconsistent'
    ))
  );
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

export function migrate(db: Db, targetVersion = MIGRATIONS.length): number {
  if (!Number.isInteger(targetVersion) || targetVersion < 0 || targetVersion > MIGRATIONS.length) {
    throw new Error(`无效的数据库迁移目标版本 ${targetVersion}，应为 0..${MIGRATIONS.length} 的整数`);
  }
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  let current = row?.version ?? 0;
  if (row === undefined) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();

  // targetVersion 只供测试构造旧库，不是降级入口。库比目标新时原样返回。
  for (let v = current; v < targetVersion; v++) {
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
