import Link from "next/link";
import { unifyPeople } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { type PersonValues, PersonFields } from "@/components/person-form";
import { Empty, fmtDate } from "@/components/ui";
import { findDuplicatePairs, nameKey } from "@/lib/people";
import { type PersonRow, listPeople } from "@/lib/queries";
import { PERSON_SHORT } from "@/lib/status";

const FIELDS = [
  "name", "company", "job_title", "department", "hierarchy_level", "influence", "reports_to_id",
  "email", "phone", "linkedin",
] as const;

/** Distintos valores no vacíos, empezando por la ficha principal. */
function distinct(values: (string | null | undefined)[]) {
  const seen = new Map<string, string>();
  for (const v of values) if (v?.trim() && !seen.has(nameKey(v))) seen.set(nameKey(v), v.trim());
  return [...seen.values()];
}

export default async function UnifyPage({ searchParams }: PageProps<"/personas/unificar">) {
  const sp = await searchParams;
  const raw = ([] as string[]).concat(sp.ids ?? []).flatMap((x) => x.split(","));
  const people = await listPeople();
  const byId = new Map(people.map((p) => [p.id, p]));
  const selected = [...new Set(raw)].map((id) => byId.get(id)).filter((p): p is PersonRow => !!p);
  const pairs = findDuplicatePairs(people);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="muted"><Link href="/personas">Personas</Link></div>
          <h1>Unificar duplicados</h1>
          <p className="muted">
            Elige las fichas que son la misma persona, decide qué datos conservar y añade el contexto que falte.
            Los demás nombres se guardan como alias para que la IA la reconozca en próximas reuniones.
          </p>
        </div>
      </div>

      {selected.length >= 2 ? (
        <Compare selected={selected} people={people} />
      ) : (
        <>
          <section className="card">
            <h3>Posibles duplicados detectados ({pairs.length})</h3>
            {pairs.length === 0 && <p className="muted small">No se han detectado duplicados evidentes.</p>}
            <ul className="dup-list">
              {pairs.map((d) => {
                const a = byId.get(d.a)!, b = byId.get(d.b)!;
                return (
                  <li key={`${d.a}-${d.b}`}>
                    <strong>{a.name}</strong>{a.company && <span className="muted"> · {a.company}</span>}
                    {" ↔ "}
                    <strong>{b.name}</strong>{b.company && <span className="muted"> · {b.company}</span>}
                    <span className="muted small"> ({d.reason.toLowerCase()})</span>{" "}
                    <Link className="btn small" href={`/personas/unificar?ids=${a.id},${b.id}`}>Revisar y unificar</Link>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="card">
            <h3>Elegir fichas a mano</h3>
            {people.length < 2 ? <Empty>Hacen falta al menos dos personas.</Empty> : (
              <form method="get" className="stack">
                <div className="pick-list tall">
                  {people.map((p) => (
                    <label key={p.id} className="check">
                      <input type="checkbox" name="ids" value={p.id} defaultChecked={raw.includes(p.id)} />
                      <span>
                        {p.name}
                        <span className="muted small">
                          {[p.job_title, p.company].filter(Boolean).map((x) => ` · ${x}`).join("")}
                          {` · ${p.project_count} proyecto(s)`}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <div><button className="btn primary">Comparar seleccionadas</button></div>
              </form>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Compare({ selected, people }: { selected: PersonRow[]; people: PersonRow[] }) {
  // Principal por defecto: la ficha con más proyectos y acciones.
  const main = [...selected].sort((a, b) =>
    b.project_count + b.open_tasks - (a.project_count + a.open_tasks))[0];
  const ordered = [main, ...selected.filter((p) => p.id !== main.id)];
  const ids = selected.map((p) => p.id);

  const defaults: PersonValues = {};
  const choices: Partial<Record<keyof PersonValues, string[]>> = {};
  for (const f of FIELDS) {
    const vals = distinct(ordered.map((p) => p[f]));
    defaults[f] = vals[0] ?? null;
    choices[f] = vals;
  }
  // Notas y perfil: se combinan todos.
  defaults.notes = distinct(ordered.map((p) => p.notes)).join("\n\n") || null;
  defaults.ai_profile = distinct(ordered.map((p) => p.ai_profile)).join("\n\n") || null;

  const row = (label: string, get: (p: PersonRow) => React.ReactNode) => (
    <tr>
      <th>{label}</th>
      {ordered.map((p) => <td key={p.id}>{get(p) || <span className="muted">—</span>}</td>)}
    </tr>
  );

  return (
    <ActionForm action={unifyPeople} className="stack">
      {ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
      <section className="card">
        <h3>1. Compara las fichas</h3>
        <div className="compare-wrap">
        <table className="compare">
          <thead>
            <tr>
              <th />
              {ordered.map((p) => (
                <th key={p.id}>
                  <label className="check">
                    <input type="radio" name="main" value={p.id} defaultChecked={p.id === main.id} />
                    Conservar como principal
                  </label>
                  <Link href={`/personas?id=${p.id}`}>{p.name}</Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row("Empresa", (p) => p.company)}
            {row("Cargo", (p) => p.job_title)}
            {row("Departamento", (p) => p.department)}
            {row("Nivel", (p) => p.hierarchy_level && PERSON_SHORT[p.hierarchy_level])}
            {row("Influencia", (p) => p.influence && PERSON_SHORT[p.influence])}
            {row("Email", (p) => p.email)}
            {row("Teléfono", (p) => p.phone)}
            {row("Alias", (p) => p.aliases.join(", "))}
            {row("Proyectos", (p) => String(p.project_count))}
            {row("Acciones pendientes", (p) => String(p.open_tasks))}
            {row("Última reunión", (p) => fmtDate(p.last_meeting))}
          </tbody>
        </table>
        </div>
        <p className="muted small">
          Los proyectos, acciones y reuniones de todas las fichas pasan a la ficha unificada. Las demás se eliminan.
        </p>
        <p className="small"><Link href="/personas/unificar">← Elegir otras fichas</Link></p>
      </section>

      <section className="card">
        <h3>2. Datos de la ficha unificada</h3>
        <p className="muted small">
          Cada campo propone el valor de la ficha principal; debajo verás las otras opciones encontradas. Puedes
          elegir una o escribir otra.
        </p>
        <div className="grid-form">
          <PersonFields v={defaults} choices={choices} people={people} excludeIds={ids} showAliases={false} />
        </div>
      </section>

      <div>
        <Submit pendingText="Unificando…">Unificar {selected.length} fichas</Submit>
      </div>
    </ActionForm>
  );
}
