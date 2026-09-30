import type { Analysis } from "./analysis";
import { type Db, one, query } from "./db";

/** Clave de comparación de nombres: minúsculas, sin tildes ni espacios sobrantes. */
export function nameKey(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

type Person = { id: number; name: string };

/**
 * Resuelve nombres de responsables ("Ana", "ana garcía") a personas:
 * primero por nombre completo y, si no, por nombre de pila cuando es único
 * entre las personas del proyecto.
 */
export class PeopleIndex {
  private full = new Map<string, Person>();
  private first = new Map<string, Person[]>();

  add(p: Person, alias?: string) {
    for (const n of [p.name, alias]) {
      const k = nameKey(n);
      if (!k) continue;
      this.full.set(k, p);
      const f = k.split(" ")[0];
      const list = this.first.get(f) ?? [];
      if (!list.some((x) => x.id === p.id)) list.push(p);
      this.first.set(f, list);
    }
  }

  find(name: string | null | undefined): Person | undefined {
    const k = nameKey(name);
    if (!k) return undefined;
    const exact = this.full.get(k);
    if (exact) return exact;
    const byFirst = this.first.get(k.split(" ")[0]);
    return byFirst?.length === 1 ? byFirst[0] : undefined;
  }
}

async function linkToProject(db: Db, projectId: number, personId: number, role?: string | null, summary?: string | null) {
  await db.query(
    `INSERT INTO project_people (project_id, person_id, role, summary) VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, person_id) DO UPDATE SET
       role = COALESCE(EXCLUDED.role, project_people.role),
       summary = COALESCE(EXCLUDED.summary, project_people.summary),
       updated_at = now()`,
    [projectId, personId, role?.trim() || null, summary?.trim() || null],
  );
}

export async function createPerson(
  db: Db,
  p: { name: string; company?: string | null; job_title?: string | null; email?: string | null;
    phone?: string | null; ai_profile?: string | null },
): Promise<number> {
  const row = await one<{ id: string }>(
    `INSERT INTO people (name, company, job_title, email, phone, ai_profile)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [p.name.trim(), p.company?.trim() || null, p.job_title?.trim() || null, p.email?.trim() || null,
     p.phone?.trim() || null, p.ai_profile?.trim() || null],
    db,
  );
  return Number(row!.id);
}

/**
 * Aplica los participantes detectados por la IA: crea las personas nuevas, completa
 * los datos que faltan de las existentes (sin pisar lo escrito a mano), actualiza su
 * papel en el proyecto y registra la asistencia. Devuelve un índice para resolver
 * responsables de tareas.
 */
export async function applyParticipants(
  db: Db,
  projectId: number,
  meetingId: number,
  participants: Analysis["participantes"],
  onCreated: (id: number, name: string, note: string) => Promise<void>,
): Promise<PeopleIndex & { ensure: (name: string) => Promise<Person | undefined> }> {
  const index = new PeopleIndex();
  const all = await query<{ id: string; name: string; in_project: boolean }>(
    `SELECT p.id, p.name, EXISTS (SELECT 1 FROM project_people pp
       WHERE pp.person_id = p.id AND pp.project_id = $1) AS in_project
     FROM people p ORDER BY in_project DESC, p.id`,
    [projectId], db,
  );
  const byId = new Map(all.map((p) => [Number(p.id), { id: Number(p.id), name: p.name }]));
  const byName = new Map(all.map((p) => [nameKey(p.name), { id: Number(p.id), name: p.name }]));
  // Para el nombre de pila solo cuentan las personas del proyecto (evita confundir a dos "Ana").
  for (const p of all) if (p.in_project) index.add({ id: Number(p.id), name: p.name });

  for (const x of participants) {
    const name = x.nombre?.trim();
    if (!name) continue;
    let person = (x.persona_id != null ? byId.get(x.persona_id) : undefined) ?? byName.get(nameKey(name));
    if (!person) {
      const id = await createPerson(db, {
        name, company: x.empresa, job_title: x.cargo, email: x.email, phone: x.telefono, ai_profile: x.perfil,
      });
      person = { id, name };
      byId.set(id, person);
      byName.set(nameKey(name), person);
      await onCreated(id, name, [x.cargo, x.empresa].filter(Boolean).join(" · "));
    } else {
      await db.query(
        `UPDATE people SET
           company = COALESCE(company, $2), job_title = COALESCE(job_title, $3),
           email = COALESCE(email, $4), phone = COALESCE(phone, $5),
           ai_profile = COALESCE($6, ai_profile), updated_at = now()
         WHERE id = $1`,
        [person.id, x.empresa?.trim() || null, x.cargo?.trim() || null, x.email?.trim() || null,
         x.telefono?.trim() || null, x.perfil?.trim() || null],
      );
    }
    await linkToProject(db, projectId, person.id, x.rol_en_proyecto, x.resumen_en_proyecto);
    if (x.asistio) {
      await db.query(
        "INSERT INTO meeting_people (meeting_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [meetingId, person.id],
      );
    }
    index.add(person, name);
  }

  /** Busca un responsable y, si no existe, lo crea y lo vincula al proyecto. */
  const ensure = async (name: string) => {
    if (!name.trim()) return undefined;
    const found = index.find(name) ?? byName.get(nameKey(name));
    if (found) {
      await linkToProject(db, projectId, found.id);
      index.add(found);
      return found;
    }
    const id = await createPerson(db, { name });
    const person = { id, name: name.trim() };
    byName.set(nameKey(name), person);
    index.add(person);
    await linkToProject(db, projectId, id);
    await onCreated(id, person.name, "Responsable de una tarea");
    return person;
  };
  return Object.assign(index, { ensure });
}
