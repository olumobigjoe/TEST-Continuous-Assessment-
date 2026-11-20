import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('lecturer','student'))
);

-- Internal table name "tests"; all user-facing wording comes from shared/terms.ts
CREATE TABLE IF NOT EXISTS tests (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  lecturer_id TEXT NOT NULL REFERENCES users(id),
  generation_mode TEXT NOT NULL DEFAULT 'manual' CHECK (generation_mode IN ('ai','manual')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  locked INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL,
  window_start INTEGER NOT NULL,     -- epoch ms
  window_end INTEGER NOT NULL,       -- epoch ms
  duration_minutes INTEGER NOT NULL,
  questions_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1, -- bumped on every schedule change (optimistic concurrency)
  cancel_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batch_students (
  test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (test_id, student_id)            -- one batch per student per TEST
);

-- A student's sitting. Timing is snapshotted at start and never changed by schedule edits.
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL REFERENCES tests(id),
  batch_id TEXT NOT NULL REFERENCES batches(id),
  student_id TEXT NOT NULL REFERENCES users(id),
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  allocated_minutes INTEGER NOT NULL,
  submitted_at INTEGER,
  submit_reason TEXT CHECK (submit_reason IN ('student','auto_expired')),
  answers_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (test_id, student_id)
);

CREATE TABLE IF NOT EXISTS schedule_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT,
  changes_json TEXT NOT NULL DEFAULT '[]',
  before_json TEXT,
  after_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  test_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('in_app','email')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  read_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_attempts_open ON attempts(submitted_at, deadline_at);
CREATE INDEX IF NOT EXISTS idx_batches_test ON batches(test_id);
CREATE INDEX IF NOT EXISTS idx_audit_test ON schedule_audit(test_id, created_at);
`;

export function openDb(path = ':memory:'): DB {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Serialises writers. node:sqlite is synchronous, so the whole check-then-write runs atomically. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

let counter = 0;
export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
