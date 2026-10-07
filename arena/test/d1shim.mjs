// A stand-in for Cloudflare D1 on top of Node's built-in SQLite, for tests.
// Supports what the worker uses: prepare().bind().first()/all()/run() and batch().

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

class Stmt {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Stmt(this.db, this.sql, args);
  }

  _run() {
    const s = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) return { results: s.all(...this.args), meta: { changes: 0 } };
    const r = s.run(...this.args);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  async first() {
    return this._run().results[0] ?? null;
  }

  async all() {
    return this._run();
  }

  async run() {
    return this._run();
  }
}

export function d1(schemaFiles = []) {
  const db = new DatabaseSync(':memory:');
  for (const f of schemaFiles) db.exec(readFileSync(f, 'utf8'));
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._run());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
