/** Rows retain nonce/revision fences until their instance is explicitly removed. Capacity never drops a fence. */
export const PRESENCE_OBSERVERS_SCHEMA = `
CREATE TABLE presence_observer_device (
  instance_id TEXT NOT NULL REFERENCES instance(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  blocked_unknown INTEGER NOT NULL DEFAULT 0 CHECK(blocked_unknown IN(0,1)),
  PRIMARY KEY(instance_id,node_id)
);
CREATE TABLE presence_observer (
  instance_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  observer_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  current_run TEXT,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
  state TEXT NOT NULL DEFAULT 'unknown' CHECK(state IN('unknown','online','offline')),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN('active','stopped','retired')),
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(instance_id,node_id,observer_id),
  FOREIGN KEY(instance_id,node_id) REFERENCES presence_observer_device(instance_id,node_id) ON DELETE CASCADE
);
CREATE TABLE presence_observer_run (
  instance_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  observer_id TEXT NOT NULL,
  run_nonce TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  ticket TEXT NOT NULL UNIQUE,
  ticket_expires_at INTEGER NOT NULL,
  activated_generation INTEGER,
  previous_generation INTEGER,
  PRIMARY KEY(instance_id,node_id,observer_id,run_nonce),
  FOREIGN KEY(instance_id,node_id,observer_id) REFERENCES presence_observer(instance_id,node_id,observer_id) ON DELETE CASCADE
);
CREATE INDEX idx_presence_observer_lease ON presence_observer(lease_expires_at);
`;
