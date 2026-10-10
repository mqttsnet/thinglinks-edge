/** No cascading instance FK: an unresolved cleanup intent must outlive its instance record. */
export const PROTOCOL_DIAGNOSTIC_SCHEMA = `
CREATE TABLE protocol_diagnostic (
 id TEXT PRIMARY KEY,
 instance_id TEXT NOT NULL,
 cleanup TEXT NOT NULL CHECK(cleanup IN ('pending','done','failed')),
 created_at INTEGER NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json))
);
CREATE UNIQUE INDEX protocol_diagnostic_active ON protocol_diagnostic(instance_id) WHERE cleanup != 'done';
CREATE INDEX protocol_diagnostic_recent ON protocol_diagnostic(instance_id, created_at DESC);
`;
