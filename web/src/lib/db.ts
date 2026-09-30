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

const state = globalThis as unknown as { __schemaReady?: Promise<void> };

/**
 * Garantiza que el esquema está migrado antes de la primera consulta.
 * Si falla (p. ej. la base de datos aún está arrancando), se reintentará en la
 * siguiente petición en lugar de dejar el servidor roto.
 */
export function ensureSchema(): Promise<void> {
  state.__schemaReady ??= import("./migrations")
    .then((m) => m.migrate())
    .catch((e) => {
      state.__schemaReady = undefined;
      throw e;
    });
  return state.__schemaReady;
}

export async function query<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db?: Db,
): Promise<T[]> {
  if (!db) await ensureSchema();
  const res = await (db ?? pool()).query<T>(sql, params);
  return res.rows;
}

export async function one<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db?: Db,
): Promise<T | undefined> {
  return (await query<T>(sql, params, db))[0];
}

export async function tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
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
