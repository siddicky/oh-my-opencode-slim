import { Database } from 'bun:sqlite';
import { SqliteWorkflowJournal } from './core';
import type { JournalDatabase, SqlRunResult, WorkflowJournal } from './types';

function normalizeInteger(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}
function createBunDatabase(path: string): JournalDatabase {
  const database = new Database(path, { strict: true });
  return {
    exec(sql) {
      database.exec(sql);
    },
    run(sql, bindings = []): SqlRunResult {
      const result = database.query(sql).run(...bindings);
      return {
        changes: result.changes,
        lastInsertRowid: normalizeInteger(result.lastInsertRowid),
      };
    },
    get(sql, bindings = []) {
      return database.query(sql).get(...bindings);
    },
    all(sql, bindings = []): readonly unknown[] {
      return database.query(sql).all(...bindings);
    },
    close() {
      database.close();
    },
  };
}
export function createBunJournal(path: string): WorkflowJournal {
  const database = createBunDatabase(path);
  try {
    return new SqliteWorkflowJournal(database);
  } catch (error) {
    database.close();
    throw error;
  }
}
