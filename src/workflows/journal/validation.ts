import { z } from 'zod';
import { JournalInputError } from './types';

const ownedRowSchema = z.object({ owned: z.number().int() });
const versionRowSchema = z.object({ user_version: z.number().int() });
const integrityRowSchema = z.object({ integrity_check: z.string() });
const journalModeRowSchema = z.object({ journal_mode: z.string() });
const foreignKeysRowSchema = z.object({ foreign_keys: z.number().int() });
const synchronousRowSchema = z.object({ synchronous: z.number().int() });
const stateKindSchema = z.union([
  z.literal('approval'),
  z.literal('node-attempt'),
  z.literal('reservation'),
  z.literal('run'),
]);
export const operationRowSchema = z.object({
  operation_id: z.string(),
  effect_json: z.string(),
  result_json: z.string().nullable(),
});
export const outboxRowSchema = z.object({
  operation_id: z.string(),
  kind: z.union([z.literal('effect'), z.literal('result')]),
  payload_json: z.string(),
  status: z.union([z.literal('pending'), z.literal('delivered')]),
});
export const stateRowSchema = z.object({
  kind: stateKindSchema,
  payload_json: z.string(),
  record_id: z.string(),
});
export const eventRowSchema = z.object({
  event_id: z.string(),
  payload_json: z.string(),
  sequence: z.number().int().nonnegative(),
});
export const checkpointRowSchema = z.object({
  delivery_cursor: z.number().int().nonnegative(),
  journal_cursor: z.number().int().nonnegative(),
  metadata_json: z.string(),
  run_id: z.string(),
  snapshot: z.instanceof(Uint8Array),
});
export const schemaObjectRowSchema = z.object({
  name: z.string(),
  sql: z.string(),
  tbl_name: z.string(),
  type: z.literal('table'),
});
export function requireIdentifier(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new JournalInputError(`${label} must not be empty`);
  }
  return value;
}
export function serializePayload(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new JournalInputError(`payload is not JSON: ${error.message}`);
    }
    throw error;
  }
  if (encoded === undefined) {
    throw new JournalInputError('payload must be a JSON value');
  }
  return encoded;
}
export function requireCursor(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JournalInputError(`${label} must be a non-negative integer`);
  }
  return value;
}
export function parsePayload(value: string): unknown {
  return JSON.parse(value);
}
export function parseOwned(row: unknown): boolean {
  return ownedRowSchema.parse(row).owned === 1;
}
export function parseVersion(row: unknown): number {
  return versionRowSchema.parse(row).user_version;
}
export function parseIntegrity(row: unknown): string {
  return integrityRowSchema.parse(row).integrity_check;
}
export function parseJournalMode(row: unknown): string {
  return journalModeRowSchema.parse(row).journal_mode;
}
export function parseForeignKeys(row: unknown): number {
  return foreignKeysRowSchema.parse(row).foreign_keys;
}
export function parseSynchronous(row: unknown): number {
  return synchronousRowSchema.parse(row).synchronous;
}
