import Link from "next/link";
import { deletePerson, mergePeople, savePerson, setTaskStatus } from "@/app/actions";
import { ActionForm, StatusSelect, Submit } from "@/components/forms";
import { PeopleSidebar } from "@/components/people-sidebar";
import { initials } from "@/lib/format";
import { Badge, Empty, Md, fmtDate, fmtDateTime } from "@/components/ui";
import {
  type PersonRow, getPerson, listPeople, personMeetings, personProjects, personTasks,
} from "@/lib/queries";
import { LABELS, TASK_STATUSES, isClosedTask } from "@/lib/status";

function PersonFields({ p }: { p?: PersonRow }) {
  return (
    <>
      {p && <input type="hidden" name="id" value={p.id} />}
      <label>Nombre *<input name="name" defaultValue={p?.name} required /></label>
      <label>Empresa<input name="company" defaultValue={p?.company ?? ""} /></label>
      <label>Cargo<input name="job_title" defaultValue={p?.job_title ?? ""} /></label>
      <label>Email<input name="email" type="email" defaultValue={p?.email ?? ""} /></label>
      <label>Teléfono<input name="phone" defaultValue={p?.phone ?? ""} /></label>
      <label className="span-2">Notas propias<textarea name="notes" rows={2} defaultValue={p?.notes ?? ""} /></label>
      {p && (
        <label className="span-2">Perfil (lo mantiene la IA; puedes corregirlo)
          <textarea name="ai_profile" rows={3} defaultValue={p.ai_profile ?? ""} />
        </label>
      )}
    </>
  );
}

export default async function PeoplePage({ searchParams }: PageProps<"/personas">) {
  const sp = await searchParams;
  const id = typeof sp.id === "string" && /^\d+$/.test(sp.id) ? sp.id : undefined;
  const creating = sp.nueva === "1";
  const people = await listPeople();
  const person = id ? await getPerson(id) : undefined;

  return (
    <>
      <div className="page-head">
        <h1>Personas</h1>
        <span className="muted">{people.length} personas registradas</span>
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
                <PersonFields />
                <div className="span-2"><Submit>Crear persona</Submit></div>
              </ActionForm>
            </div>
          ) : person ? (
            <PersonDetail person={person} others={people.filter((p) => p.id !== person.id)} />
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

async function PersonDetail({ person: p, others }: { person: PersonRow; others: PersonRow[] }) {
  const [projects, tasks, meetings] = await Promise.all([
    personProjects(p.id), personTasks(p.id), personMeetings(p.id),
  ]);
  return (
    <>
      <div className="card person-head">
        <span className="avatar big">{initials(p.name)}</span>
        <div className="person-head-main">
          <h2>{p.name}</h2>
          <div className="muted">{[p.job_title, p.company].filter(Boolean).join(" · ") || "Cargo y empresa sin datos"}</div>
          <div className="contact">
            {p.email && <a href={`mailto:${p.email}`}>✉️ {p.email}</a>}
            {p.phone && <a href={`tel:${p.phone.replace(/\s+/g, "")}`}>📞 {p.phone}</a>}
            {!p.email && !p.phone && <span className="muted small">Sin datos de contacto</span>}
          </div>
        </div>
        <details className="menu">
          <summary className="btn">Editar</summary>
          <div className="menu-body wide">
            <ActionForm action={savePerson} className="grid-form">
              <PersonFields p={p} />
              <div className="span-2"><Submit>Guardar</Submit></div>
            </ActionForm>
            {others.length > 0 && (
              <ActionForm action={mergePeople} className="stack merge"
                confirm="Se moverán proyectos, tareas y reuniones de la otra ficha a esta y se borrará la otra. ¿Continuar?">
                <input type="hidden" name="id" value={p.id} />
                <label>¿Es la misma persona que…? (unir fichas duplicadas)
                  <select name="merge_from" required defaultValue="">
                    <option value="" disabled>Elige la ficha duplicada…</option>
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}{o.company ? ` · ${o.company}` : ""}</option>
                    ))}
                  </select>
                </label>
                <Submit className="btn" pendingText="Uniendo…">Unir con esta ficha</Submit>
              </ActionForm>
            )}
            <ActionForm action={deletePerson} confirm={`¿Eliminar a ${p.name}? Sus tareas quedarán sin persona asignada.`}>
              <input type="hidden" name="id" value={p.id} />
              <Submit className="btn danger link" pendingText="Eliminando…">Eliminar persona</Submit>
            </ActionForm>
          </div>
        </details>
      </div>

      <div className="stats">
        <div className="stat"><div className="stat-value">{projects.length}</div><div className="stat-label">Proyectos</div></div>
        <div className="stat"><div className="stat-value">{p.open_tasks}</div><div className="stat-label">Acciones pendientes</div></div>
        <div className="stat"><div className="stat-value">{meetings.length}</div><div className="stat-label">Reuniones</div></div>
        <div className="stat"><div className="stat-value small-value">{fmtDate(p.last_meeting)}</div><div className="stat-label">Última reunión</div></div>
      </div>

      {(p.ai_profile || p.notes) && (
        <section className="card">
          <h3>Quién es</h3>
          {p.ai_profile && <Md>{p.ai_profile}</Md>}
          {p.notes && <p className="notes"><strong>Mis notas:</strong> {p.notes}</p>}
        </section>
      )}

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
