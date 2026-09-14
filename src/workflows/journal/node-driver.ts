import { DatabaseSync } from 'node:sqlite';
import { SqliteWorkflowJournal } from './core';
import type { JournalDatabase, SqlRunResult, WorkflowJournal } from './types';

function normalizeInteger(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

function closeStatement(statement: object): void {
  if ('close' in statement && typeof statement.close === 'function') {
    statement.close();
  }
}
function createNodeDatabase(path: string): JournalDatabase {
  const database = new DatabaseSync(path, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    timeout: 100,
  });
  return {
    exec(sql) {
      database.exec(sql);
    },
    run(sql, bindings = []): SqlRunResult {
      const statement = database.prepare(sql);
      try {
        const result = statement.run(...bindings);
        return {
          changes: normalizeInteger(result.changes),
          lastInsertRowid: normalizeInteger(result.lastInsertRowid),
        };
      } finally {
        closeStatement(statement);
      }
    },
    get(sql, bindings = []) {
      const statement = database.prepare(sql);
      try {
        return statement.get(...bindings);
      } finally {
        closeStatement(statement);
      }
    },
    all(sql, bindings = []): readonly unknown[] {
      const statement = database.prepare(sql);
      try {
        return statement.all(...bindings);
      } finally {
        closeStatement(statement);
      }
    },
    close() {
      database.close();
    },
  };
}
export function createNodeJournal(path: string): WorkflowJournal {
  const database = createNodeDatabase(path);
  try {
    return new SqliteWorkflowJournal(database);
  } catch (error) {
    database.close();
    throw error;
  }
}
