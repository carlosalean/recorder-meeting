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
  const all = await query<{ id: string; name: string; aliases: string[]; in_project: boolean }>(
    `SELECT p.id, p.name, p.aliases, EXISTS (SELECT 1 FROM project_people pp
       WHERE pp.person_id = p.id AND pp.project_id = $1) AS in_project
     FROM people p ORDER BY in_project DESC, p.id`,
    [projectId], db,
  );
  const byId = new Map(all.map((p) => [Number(p.id), { id: Number(p.id), name: p.name }]));
  // Nombre y alias (p. ej. nombres de fichas unificadas) → persona.
  const byName = new Map<string, Person>();
  for (const p of all) {
    const person = { id: Number(p.id), name: p.name };
    for (const n of [p.name, ...(p.aliases ?? [])]) if (!byName.has(nameKey(n))) byName.set(nameKey(n), person);
  }
  // Para el nombre de pila solo cuentan las personas del proyecto (evita confundir a dos "Ana").
  for (const p of all) {
    if (!p.in_project) continue;
    const person = { id: Number(p.id), name: p.name };
    index.add(person);
    for (const alias of p.aliases ?? []) index.add(person, alias);
  }

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

// ---------------------------------------------------------------------------
// Duplicados
// ---------------------------------------------------------------------------

export type DupCandidate = {
  id: string; name: string; aliases?: string[] | null; email?: string | null; company?: string | null;
};
export type DupPair = { a: string; b: string; reason: string };

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

/**
 * Sugiere parejas de fichas que probablemente son la misma persona:
 * mismo nombre, un nombre contenido en el otro ("Ana" / "Ana García"),
 * pequeñas diferencias de transcripción ("Garsia") o el mismo email.
 */
export function findDuplicatePairs(people: DupCandidate[]): DupPair[] {
  const pairs: DupPair[] = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i], b = people[j];
      const reason = duplicateReason(a, b);
      if (reason) pairs.push({ a: a.id, b: b.id, reason });
    }
  }
  return pairs;
}

function duplicateReason(a: DupCandidate, b: DupCandidate): string | null {
  if (a.email && b.email && nameKey(a.email) === nameKey(b.email)) return "Mismo email";
  const companiesClash = a.company && b.company && nameKey(a.company) !== nameKey(b.company);
  const namesA = [a.name, ...(a.aliases ?? [])].map(nameKey).filter(Boolean);
  const namesB = [b.name, ...(b.aliases ?? [])].map(nameKey).filter(Boolean);
  if (namesA.some((x) => namesB.includes(x))) return companiesClash ? null : "Mismo nombre";
  if (companiesClash) return null;
  for (const x of namesA) {
    for (const y of namesB) {
      const [short, long] = x.length <= y.length ? [x, y] : [y, x];
      if (long.split(" ")[0] === short.split(" ")[0] && long.startsWith(short + " ")) {
        return "Un nombre contiene al otro";
      }
      if (short.length >= 5 && levenshtein(x, y) <= 2) return "Nombre muy parecido";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unificar fichas
// ---------------------------------------------------------------------------

export type MergeValues = {
  name: string; company: string | null; job_title: string | null; department: string | null;
  hierarchy_level: string | null; influence: string | null; reports_to_id: string | null;
  email: string | null; phone: string | null; linkedin: string | null; notes: string | null;
  ai_profile: string | null;
};

/**
 * Une varias fichas en `mainId`: mueve proyectos, reuniones, tareas y subordinados,
 * guarda los valores elegidos y conserva los demás nombres como alias para que la IA
 * reconozca a la persona en futuras reuniones.
 */
export async function mergePeople(db: Db, mainId: string, otherIds: string[], v: MergeValues) {
  const others = otherIds.filter((x) => x !== mainId);
  if (!others.length) return;
  const all = [mainId, ...others];
  await db.query("UPDATE tasks SET owner_person_id = $1 WHERE owner_person_id = ANY($2::bigint[])", [mainId, others]);
  await db.query(
    `INSERT INTO project_people (project_id, person_id, role, summary)
       SELECT project_id, $1, string_agg(DISTINCT role, ' / '), string_agg(summary, ' ')
       FROM project_people WHERE person_id = ANY($2::bigint[]) GROUP BY project_id
     ON CONFLICT (project_id, person_id) DO UPDATE SET
       role = COALESCE(project_people.role, EXCLUDED.role),
       summary = CONCAT_WS(' ', project_people.summary, EXCLUDED.summary), updated_at = now()`,
    [mainId, others]);
  await db.query(
    `INSERT INTO meeting_people (meeting_id, person_id)
       SELECT DISTINCT meeting_id, $1::bigint FROM meeting_people WHERE person_id = ANY($2::bigint[])
     ON CONFLICT DO NOTHING`, [mainId, others]);
  await db.query("UPDATE people SET reports_to_id = $1 WHERE reports_to_id = ANY($2::bigint[])", [mainId, others]);

  // Alias: todos los nombres y alias de las fichas, salvo el nombre final.
  const names = await query<{ name: string; aliases: string[] }>(
    "SELECT name, aliases FROM people WHERE id = ANY($1::bigint[])", [all], db);
  const aliases = new Map<string, string>();
  for (const n of names.flatMap((x) => [x.name, ...(x.aliases ?? [])])) {
    if (nameKey(n) && nameKey(n) !== nameKey(v.name) && !aliases.has(nameKey(n))) aliases.set(nameKey(n), n.trim());
  }
  const reportsTo = v.reports_to_id && !all.includes(v.reports_to_id) ? v.reports_to_id : null;
  await db.query(
    `UPDATE people SET name = $2, company = $3, job_title = $4, department = $5, hierarchy_level = $6,
       influence = $7, reports_to_id = $8, email = $9, phone = $10, linkedin = $11, notes = $12,
       ai_profile = $13, aliases = $14, updated_at = now()
     WHERE id = $1`,
    [mainId, v.name.trim(), v.company, v.job_title, v.department, v.hierarchy_level, v.influence, reportsTo,
     v.email, v.phone, v.linkedin, v.notes, v.ai_profile, [...aliases.values()]]);
  await db.query("DELETE FROM people WHERE id = ANY($1::bigint[])", [others]);
}
