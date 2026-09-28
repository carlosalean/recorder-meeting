import { pool } from "./db";

/**
 * Migraciones de esquema. Se aplican en orden al arrancar el servidor
 * (ver src/instrumentation.ts). Para cambiar el esquema, añade una nueva
 * entrada al final; nunca edites una ya aplicada.
 */
const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_inicial",
    sql: `
      CREATE TABLE clients (
        id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name         text NOT NULL UNIQUE,
        contact_name text,
        email        text,
        phone        text,
        notes        text,
        created_at   timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE projects (
        id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        client_id   bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        name        text NOT NULL,
        description text,
        status      text NOT NULL DEFAULT 'activo'
                    CHECK (status IN ('activo', 'en_pausa', 'cerrado')),
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (client_id, name)
      );

      CREATE TABLE meetings (
        id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        project_id   bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title        text NOT NULL,
        meeting_date timestamptz NOT NULL DEFAULT now(),
        source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('grabadora', 'manual')),
        source_path  text UNIQUE,          -- carpeta de la grabadora (relativa a REUNIONES_DIR)
        audio_file   text,                 -- ruta relativa del audio dentro de REUNIONES_DIR
        transcript   text NOT NULL,
        recorder_summary text,             -- resumen.md generado por la grabadora, si existe
        ai_summary   text,                 -- resumen generado al incorporar la reunión al proyecto
        status       text NOT NULL DEFAULT 'pendiente'
                     CHECK (status IN ('pendiente', 'procesando', 'procesada', 'error')),
        error        text,
        processed_at timestamptz,
        created_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX ON meetings (project_id, meeting_date);

      CREATE TABLE topics (
        id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        project_id         bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title              text NOT NULL,
        description        text,
        status             text NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto', 'cerrado')),
        created_meeting_id bigint REFERENCES meetings(id) ON DELETE SET NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        closed_at          timestamptz
      );
      CREATE INDEX ON topics (project_id);

      CREATE TABLE tasks (
        id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        topic_id           bigint NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        title              text NOT NULL,
        description        text,
        owner              text,
        due_date           date,
        status             text NOT NULL DEFAULT 'pendiente'
                           CHECK (status IN ('pendiente', 'en_progreso', 'bloqueada', 'completada', 'cancelada')),
        created_meeting_id bigint REFERENCES meetings(id) ON DELETE SET NULL,
        last_meeting_id    bigint REFERENCES meetings(id) ON DELETE SET NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        closed_at          timestamptz
      );
      CREATE INDEX ON tasks (topic_id);

      -- Historial: cada cambio de tema/tarea, hecho por una reunión (IA) o a mano.
      CREATE TABLE changes (
        id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        meeting_id  bigint REFERENCES meetings(id) ON DELETE SET NULL,
        entity      text NOT NULL CHECK (entity IN ('tema', 'tarea')),
        entity_id   bigint NOT NULL,
        entity_title text NOT NULL,
        action      text NOT NULL CHECK (action IN ('creado', 'estado', 'actualizado', 'eliminado')),
        old_status  text,
        new_status  text,
        note        text,
        evidence    text,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX ON changes (project_id, created_at DESC);
      CREATE INDEX ON changes (meeting_id);
    `,
  },
];

export async function migrate(): Promise<void> {
  const client = await pool().connect();
  try {
    // Evita que dos procesos migren a la vez.
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set(
      (await client.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id),
    );
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
        console.log(`[db] migración aplicada: ${m.id}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    // Reuniones que quedaron a medias si el servidor se paró mientras se procesaban.
    await client.query(
      `UPDATE meetings SET status = 'error', error = 'Procesamiento interrumpido (el servidor se reinició). Pulsa reintentar.'
       WHERE status = 'procesando'`,
    );
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
}
