import { Pool } from "pg";
import type { Store, Transaction } from "@splitin/spiderman-core";
export class PostgresStore implements Store {
  readonly pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
  }
  async migrate() {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS spiderman_records(kind text NOT NULL,id text NOT NULL,owner text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS spiderman_owner_kind ON spiderman_records(owner,kind);",
    );
  }
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('spiderman-records-v1',0))",
      );
      const tx: Transaction = {
        get: async <T>(kind: string, id: string) => {
          const r = await client.query(
            "SELECT payload FROM spiderman_records WHERE kind=$1 AND id=$2",
            [kind, id],
          );
          return r.rows[0]?.payload as T | undefined;
        },
        list: async <T>(kind: string, owner?: string) => {
          const r =
            owner === undefined
              ? await client.query(
                  "SELECT payload FROM spiderman_records WHERE kind=$1 ORDER BY id",
                  [kind],
                )
              : await client.query(
                  "SELECT payload FROM spiderman_records WHERE kind=$1 AND owner=$2 ORDER BY id",
                  [kind, owner],
                );
          return r.rows.map((row) => row.payload as T);
        },
        put: async (kind, id, owner, value) => {
          await client.query(
            "INSERT INTO spiderman_records VALUES($1,$2,$3,$4) ON CONFLICT(kind,id) DO UPDATE SET owner=excluded.owner,payload=excluded.payload",
            [kind, id, owner, JSON.stringify(value)],
          );
        },
        remove: async (kind, id) => {
          await client.query(
            "DELETE FROM spiderman_records WHERE kind=$1 AND id=$2",
            [kind, id],
          );
        },
      };
      const result = await work(tx);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}
