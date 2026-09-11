/** Append unchanged as a database migration. IF NOT EXISTS supports isolated service test construction. */
export const COMMAND_SCHEMA = `
CREATE TABLE IF NOT EXISTS cloud_command_binding (
 instance_id TEXT NOT NULL, consumer_id TEXT NOT NULL, node_id TEXT NOT NULL, service_code TEXT NOT NULL,
 commands_json TEXT NOT NULL, last_seen INTEGER NOT NULL,
 PRIMARY KEY(instance_id,consumer_id,node_id,service_code)
);
CREATE INDEX IF NOT EXISTS idx_command_binding_target ON cloud_command_binding(node_id,service_code,last_seen);
CREATE TABLE IF NOT EXISTS cloud_command_gateway (
 gateway_id TEXT PRIMARY KEY, retired_mid TEXT NOT NULL DEFAULT '0'
);
CREATE TABLE IF NOT EXISTS cloud_command (
 id TEXT PRIMARY KEY, gateway_id TEXT NOT NULL, mid TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT '', consumer_id TEXT NOT NULL DEFAULT '',
 device_id TEXT NOT NULL, service_code TEXT NOT NULL, cmd TEXT NOT NULL, params_json TEXT NOT NULL,
 product_id TEXT NOT NULL DEFAULT '', version_no TEXT NOT NULL DEFAULT '', model_checked INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL CHECK(status IN ('queued','leased','succeeded','failed','rejected','unknown')),
 result_json TEXT, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, completed_at INTEGER,
 queue_deadline INTEGER NOT NULL, lease_deadline INTEGER, lease_hash TEXT NOT NULL DEFAULT '',
 reply_pending INTEGER NOT NULL DEFAULT 0, reply_attempts INTEGER NOT NULL DEFAULT 0, reply_error TEXT NOT NULL DEFAULT '',
 UNIQUE(gateway_id,device_id,mid)
);
CREATE INDEX IF NOT EXISTS idx_command_pending ON cloud_command(instance_id,consumer_id,device_id,service_code,status,created_at);
CREATE INDEX IF NOT EXISTS idx_command_reply ON cloud_command(gateway_id,reply_pending,completed_at);
`;
