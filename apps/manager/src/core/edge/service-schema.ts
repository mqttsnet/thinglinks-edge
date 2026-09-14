/** Old records keep an empty service identity; historical ownership must never be guessed. */
export const SERVICE_SCOPED_FIELDS_SCHEMA = `
CREATE TABLE field_tag_v21 (
  instance_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  service_code TEXT NOT NULL DEFAULT '',
  tag_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  data_type TEXT NOT NULL DEFAULT '',
  last_value TEXT,
  quality TEXT NOT NULL DEFAULT '',
  last_at TEXT,
  hist_at TEXT,
  PRIMARY KEY (instance_id, node_id, service_code, tag_id),
  FOREIGN KEY (instance_id) REFERENCES instance(id) ON DELETE CASCADE
);
INSERT INTO field_tag_v21(instance_id,node_id,tag_id,name,unit,data_type,last_value,quality,last_at,hist_at)
  SELECT instance_id,node_id,tag_id,name,unit,data_type,last_value,quality,last_at,hist_at FROM field_tag;
DROP TABLE field_tag;
ALTER TABLE field_tag_v21 RENAME TO field_tag;
CREATE INDEX idx_field_tag_instance ON field_tag(instance_id);
ALTER TABLE field_value_history ADD COLUMN service_code TEXT NOT NULL DEFAULT '';
DROP INDEX idx_fvh_series;
CREATE INDEX idx_fvh_series ON field_value_history(instance_id,node_id,service_code,tag_id,at DESC);
`;
