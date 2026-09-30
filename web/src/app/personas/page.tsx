import Link from "next/link";
import { deletePerson, savePerson, setTaskStatus } from "@/app/actions";
import { ActionForm, StatusSelect, Submit } from "@/components/forms";
import { PeopleSidebar } from "@/components/people-sidebar";
import { PersonFields } from "@/components/person-form";
import { findDuplicatePairs } from "@/lib/people";
import { initials } from "@/lib/format";
import { Badge, Empty, Md, fmtDate, fmtDateTime } from "@/components/ui";
import {
  type PersonRow, getPerson, listPeople, personMeetings, personProjects, personTasks, personTeam,
} from "@/lib/queries";
import { LABELS, PERSON_LABELS, PERSON_SHORT, TASK_STATUSES, isClosedTask } from "@/lib/status";

export default async function PeoplePage({ searchParams }: PageProps<"/personas">) {
  const sp = await searchParams;
  const id = typeof sp.id === "string" && /^\d+$/.test(sp.id) ? sp.id : undefined;
  const creating = sp.nueva === "1";
  const people = await listPeople();
  const person = id ? await getPerson(id) : undefined;
  const dupPairs = findDuplicatePairs(people);
  const options = people.map((x) => ({ id: x.id, name: x.name, company: x.company }));

  return (
    <>
      <div className="page-head">
        <h1>Personas</h1>
        <div className="head-actions">
          <span className="muted">{people.length} personas registradas</span>
          <Link href="/personas/unificar" className="btn">
            Unificar duplicados{dupPairs.length > 0 && <span className="pill warn">{dupPairs.length} posibles</span>}
          </Link>
        </div>
      </div>
      <div className="people-layout">
        <PeopleSidebar selected={id} people={people.map((x) => ({
          id: x.id, name: x.name, company: x.company, job_title: x.job_title, open_tasks: x.open_tasks,
        }))} />
        <section>
          {creating ? (
            <div className="card">
              <h2>Nueva persona</h2>
              <ActionForm action={savePerson} className="grid-form">
                <PersonFields people={options} />
                <div className="span-2"><Submit>Crear persona</Submit></div>
              </ActionForm>
            </div>
          ) : person ? (
            <PersonDetail person={person} options={options} people={people}
              dups={dupPairs.filter((d) => d.a === person.id || d.b === person.id)} />
          ) : (
            <Empty>
              {people.length
                ? "Elige una persona en el listado para ver quién es, en qué proyectos participa y qué acciones tiene."
                : "Todavía no hay personas. Se crean automáticamente al procesar reuniones, o puedes añadirlas con «+ Nueva»."}
            </Empty>
          )}
        </section>
      </div>
    </>
  );
}

async function PersonDetail({ person: p, options, people, dups }: {
  person: PersonRow;
  options: { id: string; name: string; company: string | null }[];
  people: PersonRow[];
  dups: { a: string; b: string; reason: string }[];
}) {
  const [projects, tasks, meetings, team] = await Promise.all([
    personProjects(p.id), personTasks(p.id), personMeetings(p.id), personTeam(p.id),
  ]);
  const byId = new Map(people.map((x) => [x.id, x]));
  return (
    <>
      <div className="card person-head">
        <span className="avatar big">{initials(p.name)}</span>
        <div className="person-head-main">
          <h2>{p.name}</h2>
          <div className="muted">
            {[p.job_title, p.department, p.company].filter(Boolean).join(" · ") || "Cargo y empresa sin datos"}
          </div>
          <div className="tags">
            {p.hierarchy_level && <span className="pill" title={PERSON_LABELS[p.hierarchy_level]}>{PERSON_SHORT[p.hierarchy_level]}</span>}
            {p.influence && <span className={`pill inf-${p.influence}`} title={PERSON_LABELS[p.influence]}>{PERSON_SHORT[p.influence]}</span>}
            {p.aliases.length > 0 && <span className="muted small">También: {p.aliases.join(", ")}</span>}
          </div>
          <div className="contact">
            {p.email && <a href={`mailto:${p.email}`}>✉️ {p.email}</a>}
            {p.phone && <a href={`tel:${p.phone.replace(/\s+/g, "")}`}>📞 {p.phone}</a>}
            {p.linkedin && <a href={p.linkedin} target="_blank" rel="noreferrer">in LinkedIn</a>}
            {!p.email && !p.phone && !p.linkedin && <span className="muted small">Sin datos de contacto</span>}
          </div>
        </div>
        <div className="head-actions">
          <Link href={`/personas/unificar?ids=${p.id}`} className="btn">Unificar con…</Link>
          <details className="menu">
            <summary className="btn">Editar</summary>
            <div className="menu-body wide">
              <ActionForm action={savePerson} className="grid-form">
                <input type="hidden" name="id" value={p.id} />
                <PersonFields v={p} people={options} excludeIds={[p.id]} />
                <div className="span-2"><Submit>Guardar</Submit></div>
              </ActionForm>
              <ActionForm action={deletePerson} confirm={`¿Eliminar a ${p.name}? Sus tareas quedarán sin persona asignada.`}>
                <input type="hidden" name="id" value={p.id} />
                <Submit className="btn danger link" pendingText="Eliminando…">Eliminar persona</Submit>
              </ActionForm>
            </div>
          </details>
        </div>
      </div>

      {dups.length > 0 && (
        <div className="card alert warn">
          <strong>¿Es la misma persona?</strong>
          <ul className="dup-list">
            {dups.map((d) => {
              const other = byId.get(d.a === p.id ? d.b : d.a);
              if (!other) return null;
              return (
                <li key={other.id}>
                  <Link href={`/personas?id=${other.id}`}>{other.name}</Link>
                  {other.company && <span className="muted"> · {other.company}</span>}
                  <span className="muted small"> ({d.reason.toLowerCase()})</span>{" "}
                  <Link className="btn small" href={`/personas/unificar?ids=${p.id},${other.id}`}>Unificar</Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="stats">
        <div className="stat"><div className="stat-value">{projects.length}</div><div className="stat-label">Proyectos</div></div>
        <div className="stat"><div className="stat-value">{p.open_tasks}</div><div className="stat-label">Acciones pendientes</div></div>
        <div className="stat"><div className="stat-value">{meetings.length}</div><div className="stat-label">Reuniones</div></div>
        <div className="stat"><div className="stat-value small-value">{fmtDate(p.last_meeting)}</div><div className="stat-label">Última reunión</div></div>
      </div>

      <div className="two-col equal">
        <section className="card">
          <h3>Quién es</h3>
          {p.ai_profile ? <Md>{p.ai_profile}</Md> : <p className="muted small">Sin perfil todavía.</p>}
          {p.notes && (
            <div className="notes">
              <strong>📌 Notas importantes</strong>
              <p>{p.notes}</p>
            </div>
          )}
        </section>
        <section className="card">
          <h3>Organigrama</h3>
          <div className="org">
            <div className="small muted">Reporta a</div>
            {p.reports_to_id ? (
              <Link href={`/personas?id=${p.reports_to_id}`} className="person-link">
                <span className="avatar">{initials(p.reports_to_name ?? "?")}</span>
                <span className="person-link-text"><span className="person-name">{p.reports_to_name}</span></span>
              </Link>
            ) : <p className="muted small">Sin indicar (edita la ficha para añadirlo).</p>}
            <div className="small muted">Su equipo ({team.length})</div>
            {team.length === 0 && <p className="muted small">Nadie reporta a esta persona.</p>}
            {team.map((t) => (
              <Link key={t.id} href={`/personas?id=${t.id}`} className="person-link">
                <span className="avatar">{initials(t.name)}</span>
                <span className="person-link-text">
                  <span className="person-name">{t.name}</span>
                  {t.job_title && <span className="muted small">{t.job_title}</span>}
                </span>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <h2>Proyectos y acciones</h2>
      {projects.length === 0 && <Empty>No está vinculada a ningún proyecto todavía.</Empty>}
      {projects.map((pr) => {
        const prTasks = tasks.filter((t) => t.project_id === pr.project_id);
        const open = prTasks.filter((t) => !isClosedTask(t.status));
        return (
          <section key={pr.project_id} className="card person-project">
            <header className="project-head">
              <div>
                <div className="muted small">{pr.client_name}</div>
                <h3><Link href={`/proyectos/${pr.project_id}`}>{pr.project_name}</Link> <Badge status={pr.project_status} /></h3>
              </div>
              <span className="pill">{open.length} pendiente{open.length === 1 ? "" : "s"}</span>
            </header>
            {(pr.ai_summary || pr.description) && (
              <p className="about"><strong>De qué va:</strong> {pr.ai_summary || pr.description}</p>
            )}
            <div className="role-box">
              <div><strong>Su papel:</strong> {pr.role || <span className="muted">sin definir</span>}</div>
              {pr.summary && <div>{pr.summary}</div>}
            </div>
            {prTasks.length > 0 ? (
              <table className="tasks">
                <thead>
                  <tr><th className="col-status">Estado</th><th>Acción</th><th className="col-owner">Tema</th><th className="col-date">Fecha límite</th></tr>
                </thead>
                <tbody>
                  {prTasks.map((t) => (
                    <tr key={t.id} className={isClosedTask(t.status) ? "done" : ""}>
                      <td>
                        <StatusSelect key={t.status} value={t.status} options={TASK_STATUSES} labels={LABELS}
                          onChangeAction={setTaskStatus.bind(null, t.id)} />
                      </td>
                      <td className="cell-title"><div className="task-title">{t.title}</div></td>
                      <td data-label="Tema">{t.topic_title}</td>
                      <td data-label="Fecha límite" className={t.overdue ? "overdue" : ""}>{fmtDate(t.due_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted small">Sin acciones asignadas en este proyecto.</p>
            )}
          </section>
        );
      })}

      {meetings.length > 0 && (
        <section className="card">
          <h3>Reuniones en las que participó</h3>
          <ul className="meetings">
            {meetings.map((m) => (
              <li key={m.id}>
                <Link href={`/reuniones/${m.id}`}>{m.title}</Link>
                <div className="small muted">{fmtDateTime(m.meeting_date)} · {m.project_name}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
