/** Only ownership-checked sources are retained; NULL means a request remains unconfirmed. No field-table backfill. */
export const PRESENCE_SCHEMA = `
CREATE TABLE cloud_presence (
 gateway_id TEXT NOT NULL,
 instance_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 confirmed_status TEXT CHECK (confirmed_status IN ('ONLINE', 'OFFLINE')),
 source_conflict INTEGER NOT NULL DEFAULT 0 CHECK (source_conflict IN (0, 1)),
 PRIMARY KEY (gateway_id, instance_id, device_id)
);
`;
