import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

const { Pool } = pg;
const txStore = new AsyncLocalStorage();

function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function createPostgresAdapter(connectionString) {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  await pool.query("SELECT 1");
  console.log("[DB] Driver: pg | connected to PostgreSQL");

  function client() {
    return txStore.getStore() || pool;
  }

  async function run(sql, params = []) {
    const result = await client().query(toPositional(sql), params);
    return { changes: result.rowCount ?? 0, lastInsertRowid: null };
  }

  async function get(sql, params = []) {
    const result = await client().query(toPositional(sql), params);
    return result.rows[0] ?? null;
  }

  async function all(sql, params = []) {
    const result = await client().query(toPositional(sql), params);
    return result.rows;
  }

  async function exec(sql) {
    const c = client();
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s && !s.toUpperCase().startsWith("PRAGMA"));
    for (const stmt of statements) {
      if (stmt) await c.query(stmt);
    }
  }

  async function transaction(fn) {
    const c = await pool.connect();
    return txStore.run(c, async () => {
      try {
        await c.query("BEGIN");
        const result = await fn();
        await c.query("COMMIT");
        return result;
      } catch (e) {
        try { await c.query("ROLLBACK"); } catch {}
        throw e;
      } finally {
        c.release();
      }
    });
  }

  async function tableInfo(tableName) {
    const result = await pool.query(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`,
      [tableName]
    );
    return result.rows;
  }

  return {
    driver: "pg",
    isPg: true,
    run,
    get,
    all,
    exec,
    transaction,
    checkpoint() {},
    async close() { await pool.end(); },
    raw: pool,
    tableInfo,
  };
}
