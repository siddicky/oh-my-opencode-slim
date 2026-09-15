import type {
  JournalDatabase,
  JournalSchemaObject,
  JournalSnapshot,
} from './types';
import {
  checkpointRowSchema,
  eventRowSchema,
  operationRowSchema,
  outboxRowSchema,
  parsePayload,
  schemaObjectRowSchema,
  stateRowSchema,
} from './validation';

export function recoverJournal(
  database: JournalDatabase,
  projectId: string,
): JournalSnapshot {
  const operations = database
    .all(
      `SELECT operation_id, effect_json, result_json FROM operations
       WHERE project_id = ? AND effect_json IS NOT NULL
       ORDER BY operation_id`,
      [projectId],
    )
    .map((row) => operationRowSchema.parse(row))
    .map((row) => ({
      effect: parsePayload(row.effect_json),
      operationId: row.operation_id,
      result: row.result_json === null ? null : parsePayload(row.result_json),
    }));
  const outbox = database
    .all(
      `SELECT operation_id, kind, payload_json, status FROM outbox
       WHERE project_id = ? ORDER BY sequence`,
      [projectId],
    )
    .map((row) => outboxRowSchema.parse(row))
    .map((row) => ({
      kind: row.kind,
      operationId: row.operation_id,
      payload: parsePayload(row.payload_json),
      status: row.status,
    }));
  const states = database
    .all(
      `SELECT kind, record_id, payload_json FROM state_records
       WHERE project_id = ? ORDER BY kind, record_id`,
      [projectId],
    )
    .map((row) => stateRowSchema.parse(row))
    .map((row) => ({
      kind: row.kind,
      payload: parsePayload(row.payload_json),
      recordId: row.record_id,
    }));
  const events = database
    .all(
      `SELECT sequence, event_id, payload_json FROM journal_events
       WHERE project_id = ? ORDER BY sequence`,
      [projectId],
    )
    .map((row) => eventRowSchema.parse(row))
    .map((row) => ({
      eventId: row.event_id,
      payload: parsePayload(row.payload_json),
      sequence: row.sequence,
    }));
  const checkpoints = database
    .all(
      `SELECT run_id, snapshot, journal_cursor, delivery_cursor,
              metadata_json
       FROM checkpoints WHERE project_id = ? ORDER BY run_id`,
      [projectId],
    )
    .map((row) => checkpointRowSchema.parse(row))
    .map((row) => ({
      deliveryCursor: row.delivery_cursor,
      journalCursor: row.journal_cursor,
      metadata: parsePayload(row.metadata_json),
      runId: row.run_id,
      snapshot: new Uint8Array(row.snapshot),
    }));
  return { checkpoints, events, operations, outbox, states };
}

export function readSchemaObjects(
  database: JournalDatabase,
): readonly JournalSchemaObject[] {
  return database
    .all(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .map((row) => schemaObjectRowSchema.parse(row))
    .map((row) => ({
      name: row.name,
      sql: row.sql,
      tableName: row.tbl_name,
      type: row.type,
    }));
}
