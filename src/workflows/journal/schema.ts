export const JOURNAL_SCHEMA_VERSION = 2;
export const JOURNAL_MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE lease_epochs (
        epoch INTEGER PRIMARY KEY AUTOINCREMENT
      ) STRICT;
      CREATE TABLE project_leases (
        project_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        epoch INTEGER NOT NULL UNIQUE,
        heartbeat_at_ms INTEGER NOT NULL,
        FOREIGN KEY (epoch) REFERENCES lease_epochs(epoch)
      ) STRICT;
      CREATE TABLE operations (
        project_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        effect_json TEXT,
        result_json TEXT,
        PRIMARY KEY (project_id, operation_id)
      ) STRICT;
      CREATE TABLE outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('effect', 'result')),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
        UNIQUE (project_id, operation_id, kind),
        FOREIGN KEY (project_id, operation_id)
          REFERENCES operations(project_id, operation_id) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE state_records (
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (
          kind IN ('run', 'node-attempt', 'approval', 'reservation')
        ),
        record_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        writer_epoch INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, kind, record_id),
        FOREIGN KEY (writer_epoch) REFERENCES lease_epochs(epoch)
      ) STRICT;
      CREATE TABLE journal_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        writer_epoch INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE (project_id, event_id),
        FOREIGN KEY (writer_epoch) REFERENCES lease_epochs(epoch)
      ) STRICT;
      CREATE TABLE checkpoints (
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        snapshot BLOB NOT NULL,
        journal_cursor INTEGER NOT NULL,
        delivery_cursor INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        writer_epoch INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, run_id),
        FOREIGN KEY (writer_epoch) REFERENCES lease_epochs(epoch)
      ) STRICT;
    `,
  },
] as const;
const DATABASE_NOW_MS =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
export const ACQUIRE_LEASE_SQL = `
  INSERT INTO project_leases (
    project_id, owner_id, epoch, heartbeat_at_ms
  ) VALUES (?, ?, ?, ${DATABASE_NOW_MS})
  ON CONFLICT(project_id) DO UPDATE SET
    owner_id = excluded.owner_id,
    epoch = excluded.epoch,
    heartbeat_at_ms = excluded.heartbeat_at_ms
  WHERE project_leases.heartbeat_at_ms < ${DATABASE_NOW_MS} - ?
`;
export const LEASE_OWNED_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM project_leases
    WHERE project_id = ? AND owner_id = ? AND epoch = ?
      AND heartbeat_at_ms >= ${DATABASE_NOW_MS} - ?
  ) AS owned
`;
export const HEARTBEAT_SQL = `
  UPDATE project_leases SET heartbeat_at_ms = ${DATABASE_NOW_MS}
  WHERE project_id = ? AND owner_id = ? AND epoch = ?
    AND heartbeat_at_ms >= ${DATABASE_NOW_MS} - ?
`;
export const RELEASE_LEASE_SQL = `
  DELETE FROM project_leases
  WHERE project_id = ? AND owner_id = ? AND epoch = ?
    AND heartbeat_at_ms >= ${DATABASE_NOW_MS} - ?
`;
export const PERSIST_EFFECT_SQL = `
  INSERT INTO operations (project_id, operation_id, effect_json, result_json)
  SELECT ?, ?, ?, NULL WHERE EXISTS (
    SELECT 1 FROM project_leases
    WHERE project_id = ? AND owner_id = ? AND epoch = ?
      AND heartbeat_at_ms >= ${DATABASE_NOW_MS} - ?
  )
  ON CONFLICT(project_id, operation_id) DO NOTHING
`;
export const PERSIST_RESULT_SQL = `
  UPDATE operations SET result_json = ?
  WHERE project_id = ? AND operation_id = ? AND effect_json IS NOT NULL
    AND result_json IS NULL
    AND EXISTS (
      SELECT 1 FROM project_leases
      WHERE project_id = ? AND owner_id = ? AND epoch = ?
        AND heartbeat_at_ms >= ${DATABASE_NOW_MS} - ?
    )
`;
export const INSERT_OUTBOX_SQL = `
  INSERT INTO outbox (
    project_id, operation_id, kind, payload_json, status
  )
  SELECT ?, ?, ?, ?, 'pending' WHERE EXISTS (
    SELECT 1 FROM project_leases
    WHERE project_id = ? AND owner_id = ? AND epoch = ?
      AND heartbeat_at_ms >= ${DATABASE_NOW_MS} - ?
  )
  ON CONFLICT(project_id, operation_id, kind) DO NOTHING
`;
export const MARK_DELIVERED_SQL = `
  UPDATE outbox SET status = 'delivered'
  WHERE project_id = ? AND operation_id = ? AND kind = ?
    AND EXISTS (
      SELECT 1 FROM project_leases
      WHERE project_id = ? AND owner_id = ? AND epoch = ?
        AND heartbeat_at_ms >= ${DATABASE_NOW_MS} - ?
    )
`;
export const PERSIST_STATE_SQL = `
  INSERT INTO state_records (
    project_id, kind, record_id, payload_json, writer_epoch, updated_at_ms
  )
  SELECT ?, ?, ?, ?, ?, ${DATABASE_NOW_MS} WHERE EXISTS (
    SELECT 1 FROM project_leases
    WHERE project_id = ? AND owner_id = ? AND epoch = ?
      AND heartbeat_at_ms >= ${DATABASE_NOW_MS} - ?
  )
  ON CONFLICT(project_id, kind, record_id) DO UPDATE SET
    payload_json = excluded.payload_json,
    writer_epoch = excluded.writer_epoch,
    updated_at_ms = excluded.updated_at_ms
`;
export const APPEND_EVENT_SQL = `
  INSERT INTO journal_events (
    project_id, event_id, payload_json, writer_epoch, created_at_ms
  )
  SELECT ?, ?, ?, ?, ${DATABASE_NOW_MS} WHERE EXISTS (
    SELECT 1 FROM project_leases
    WHERE project_id = ? AND owner_id = ? AND epoch = ?
      AND heartbeat_at_ms >= ${DATABASE_NOW_MS} - ?
  )
  ON CONFLICT(project_id, event_id) DO NOTHING
`;
export const PERSIST_CHECKPOINT_SQL = `
  INSERT INTO checkpoints (
    project_id, run_id, snapshot, journal_cursor, delivery_cursor,
    metadata_json, writer_epoch, updated_at_ms
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ${DATABASE_NOW_MS} WHERE EXISTS (
    SELECT 1 FROM project_leases
    WHERE project_id = ? AND owner_id = ? AND epoch = ?
      AND heartbeat_at_ms >= ${DATABASE_NOW_MS} - ?
  )
  ON CONFLICT(project_id, run_id) DO UPDATE SET
    snapshot = excluded.snapshot,
    journal_cursor = excluded.journal_cursor,
    delivery_cursor = excluded.delivery_cursor,
    metadata_json = excluded.metadata_json,
    writer_epoch = excluded.writer_epoch,
    updated_at_ms = excluded.updated_at_ms
`;
