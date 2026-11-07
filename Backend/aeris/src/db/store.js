// Batched SQLite store with health check.
// Failed batches spill to disk as NDJSON.
// Spilled rows replay once the database is healthy.
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

class Store {
  constructor({ name, file, schema, statements, spillFile, onRecover }) {
    Object.assign(this, {
      name,
      file,
      schema,
      statements,
      spillFile,
      onRecover,
    });
    this.q = [];
    this.db = null;
    this.stmts = {};
    this.healthy = false;
    this.forcedDown = false;
    this.fd = null;
    this.open();
    this.flushTimer = setInterval(() => this.flush(), 200);
    this.healTimer = setInterval(() => this.recover(), 3000);
  }
  open() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.mkdirSync(path.dirname(this.spillFile), { recursive: true });
      this.db = new Database(this.file);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(this.schema);
      for (const [k, sql] of Object.entries(this.statements))
        this.stmts[k] = this.db.prepare(sql);
      this.healthy = true;
      console.log(`[db:${this.name}] open`);
    } catch (e) {
      this.healthy = false;
      console.error(`[db:${this.name}] open failed:`, e.message);
    }
    // Folds the WAL file back into the database on open.
    // Keeps queries fast under continuous ingest.
    this.checkpoint();
  }
  // Folds the WAL file back into the database.
  // Large WAL files slow down queries and replay builds.
  checkpoint() {
    if (!this.db || !this.db.open) return;
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch { /* busy: next tick retries */ }
  }
  enqueue(stmt, params) {
    this.q.push([stmt, params]);
    if (this.q.length >= 500) this.flush();
  }
  _run(items) {
    this.db.transaction((arr) => {
      for (const [s, p] of arr) this.stmts[s].run(p);
    })(items);
  }
  flush() {
    if (!this.q.length) return;
    const batch = this.q;
    this.q = [];
    if (!this.healthy || this.forcedDown) return this._spill(batch);
    try {
      this._run(batch);
    } catch (e) {
      this.healthy = false;
      console.error(
        `[db:${this.name}] write failed -> spilling to disk:`,
        e.message,
      );
      this._spill(batch);
    }
  }
  _spill(batch) {
    if (this.fd === null) this.fd = fs.openSync(this.spillFile, "a");
    fs.writeSync(
      this.fd,
      batch.map((b) => JSON.stringify(b)).join("\n") + "\n",
    );
    fs.fsyncSync(this.fd);
  }
  spillPending() {
    try {
      return fs.statSync(this.spillFile).size > 0;
    } catch {
      return false;
    }
  }
  recover() {
    if (this.forcedDown) return;
    if (this.healthy && !this.spillPending()) return;
    try {
      if (!this.db || !this.db.open) this.open();
      if (!this.db || !this.db.open) return;
      this.db.prepare("SELECT 1").get();
      this.healthy = true;
      if (this.spillPending()) {
        if (this.fd !== null) {
          fs.closeSync(this.fd);
          this.fd = null;
        }
        const lines = fs
          .readFileSync(this.spillFile, "utf8")
          .split("\n")
          .filter(Boolean);
        const items = [];
        for (const l of lines) {
          try {
            items.push(JSON.parse(l));
          } catch {}
        }
        for (let i = 0; i < items.length; i += 5000)
          this._run(items.slice(i, i + 5000));
        fs.unlinkSync(this.spillFile);
        console.log(
          `[db:${this.name}] recovered, replayed ${items.length} spilled rows`,
        );
      }
      if (this.onRecover) this.onRecover();
    } catch (e) {
      this.healthy = false;
      console.error(`[db:${this.name}] still down:`, e.message);
    }
  }
  simulateDown(v) {
    this.forcedDown = v;
    if (v) this.healthy = false;
    else this.recover();
  }
  status() {
    return {
      healthy: this.healthy && !this.forcedDown,
      queued: this.q.length,
      spillPending: this.spillPending(),
    };
  }
  close() {
    this.flush();
    clearInterval(this.flushTimer);
    clearInterval(this.healTimer);
    try {
      this.db && this.db.close();
    } catch {}
  }
}
module.exports = Store;
