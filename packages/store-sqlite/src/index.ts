import { DatabaseSync } from "node:sqlite";
import type { Store, Transaction } from "@splitin/spiderman-core";
import { mkdirSync, chmodSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
const locks = new Map<string, { tail: Promise<unknown> }>();
export class SqliteStore implements Store {
  private db: DatabaseSync;
  private lock: { tail: Promise<unknown> };
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const lockKey =
      path === ":memory:" ? Math.random().toString() : realpathSync(path);
    this.lock = locks.get(lockKey) ?? { tail: Promise.resolve() };
    locks.set(lockKey, this.lock);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS spiderman_records(kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS spiderman_owner_kind ON spiderman_records(owner,kind);",
    );
  }
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const run = this.lock.tail.then(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const tx: Transaction = {
          get: async <T>(kind: string, id: string) => {
            const row = this.db
              .prepare(
                "SELECT payload FROM spiderman_records WHERE kind=? AND id=?",
              )
              .get(kind, id);
            return row ? (JSON.parse(String(row.payload)) as T) : undefined;
          },
          list: async <T>(kind: string, owner?: string) => {
            const rows =
              owner === undefined
                ? this.db
                    .prepare(
                      "SELECT payload FROM spiderman_records WHERE kind=? ORDER BY id",
                    )
                    .all(kind)
                : this.db
                    .prepare(
                      "SELECT payload FROM spiderman_records WHERE kind=? AND owner=? ORDER BY id",
                    )
                    .all(kind, owner);
            return rows.map((row) => JSON.parse(String(row.payload)) as T);
          },
          put: async (kind, id, owner, value) => {
            this.db
              .prepare(
                "INSERT INTO spiderman_records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET owner=excluded.owner,payload=excluded.payload",
              )
              .run(kind, id, owner, JSON.stringify(value));
          },
          remove: async (kind, id) => {
            this.db
              .prepare("DELETE FROM spiderman_records WHERE kind=? AND id=?")
              .run(kind, id);
          },
        };
        const result = await work(tx);
        this.db.exec("COMMIT");
        return result;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    });
    this.lock.tail = run.catch(() => {});
    return run;
  }
  async close() {
    await this.lock.tail;
    this.db.close();
  }
}
