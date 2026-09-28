import { Pool, type PoolClient, type QueryResultRow } from "pg";

// Un único pool por proceso (en desarrollo, Next recarga módulos: se guarda en globalThis).
const g = globalThis as unknown as { __pgPool?: Pool };

export function pool(): Pool {
  if (!g.__pgPool) {
    if (!process.env.DATABASE_URL) throw new Error("Falta la variable DATABASE_URL");
    g.__pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  }
  return g.__pgPool;
}

export type Db = Pick<PoolClient, "query">;

export async function query<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db: Db = pool(),
): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db: Db = pool(),
): Promise<T | undefined> {
  return (await query<T>(sql, params, db))[0];
}

export async function tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
