import Link from "next/link";
import { notFound } from "next/navigation";
import { addMeeting, deleteProject, importRecording, retryMeeting, saveProject } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { TopicBoard } from "@/components/board";
import { ChangeList } from "@/components/changes";
import { ActionForm, Submit } from "@/components/forms";
import { ParticipantsPicker } from "@/components/participants";
import { Badge, Empty, Md, fmtDate, fmtDateTime } from "@/components/ui";
import { initials } from "@/lib/format";
import {
  getBoard, getProject, importedFolders, listChanges, listClients, listMeetings, listPeople, projectPeople,
} from "@/lib/queries";
import { listRecordings } from "@/lib/recordings";
import { LABELS, PROJECT_STATUSES } from "@/lib/status";

export default async function ProjectPage({ params }: PageProps<"/proyectos/[id]">) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const project = await getProject(id);
  if (!project) notFound();

  const [board, meetings, changes, clients, recordings, imported, people, allPeople] = await Promise.all([
    getBoard([id], { onlyOpen: false }),
    listMeetings(id),
    listChanges({ projectId: id, limit: 60 }),
    listClients(),
    listRecordings(),
    importedFolders(),
    projectPeople(id),
    listPeople(),
  ]);
  const inProject = new Set(people.map((p) => p.id));
  const pickable = allPeople.map((p) => ({ id: p.id, name: p.name, company: p.company, inProject: inProject.has(p.id) }));
  const importedSet = new Set(imported.map((i) => i.source_path));
  const pending = recordings.items.filter((r) => !importedSet.has(r.folder));
  const processing = meetings.some((m) => m.status === "procesando");

  return (
    <>
      <AutoRefresh active={processing} />
      <div className="page-head">
        <div>
          <div className="muted"><Link href={`/proyectos?cliente=${project.client_id}`}>{project.client_name}</Link></div>
          <h1>{project.name} <Badge status={project.status} /></h1>
          {project.description && <p className="muted">{project.description}</p>}
        </div>
        <details className="menu">
          <summary className="btn">Editar proyecto</summary>
          <div className="menu-body wide right">
            <ActionForm action={saveProject} className="grid-form">
              <input type="hidden" name="id" value={project.id} />
              <label>Cliente
                <select name="client_id" defaultValue={project.client_id}>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label>Nombre<input name="name" defaultValue={project.name} required /></label>
              <label className="span-2">Descripción
                <textarea name="description" rows={3} defaultValue={project.description ?? ""} />
              </label>
              <label>Estado
                <select name="status" defaultValue={project.status}>
                  {PROJECT_STATUSES.map((s) => <option key={s} value={s}>{LABELS[s]}</option>)}
                </select>
              </label>
              <div className="span-2"><Submit>Guardar</Submit></div>
            </ActionForm>
            <ActionForm action={deleteProject}
              confirm="¿Eliminar el proyecto con todas sus reuniones, temas y tareas?">
              <input type="hidden" name="id" value={project.id} />
              <Submit className="btn danger link" pendingText="Eliminando…">Eliminar proyecto</Submit>
            </ActionForm>
          </div>
        </details>
      </div>

      <div className="stats">
        <div className="stat"><div className="stat-value">{project.open_topics}</div><div className="stat-label">Temas abiertos</div></div>
        <div className="stat"><div className="stat-value">{project.open_tasks}</div><div className="stat-label">Tareas pendientes</div></div>
        <div className={`stat ${project.overdue_tasks ? "bad" : ""}`}><div className="stat-value">{project.overdue_tasks}</div><div className="stat-label">Vencidas</div></div>
        <div className="stat"><div className="stat-value">{project.meeting_count}</div><div className="stat-label">Reuniones</div></div>
      </div>

      <div className="two-col">
        <div>
          {project.ai_summary && (
            <section className="card about-card">
              <h3>De qué va</h3>
              <Md>{project.ai_summary}</Md>
              <p className="muted small">Descripción mantenida por la IA a partir de las reuniones.</p>
            </section>
          )}
          <h2>Temas y tareas</h2>
          {board.topics.length === 0 && (
            <Empty>Todavía no hay temas. Incorpora una reunión y la IA los creará a partir de la transcripción.</Empty>
          )}
          <TopicBoard topics={board.topics} tasks={board.tasks} editable projectId={id} />
        </div>

        <aside>
          <section className="card">
            <h3>Incorporar reunión</h3>
            <p className="muted small">
              La IA leerá la transcripción, creará temas y tareas nuevos y actualizará o cerrará los existentes.
            </p>
            {recordings.available && (
              pending.length ? (
                <ActionForm action={importRecording} className="stack">
                  <input type="hidden" name="project_id" value={id} />
                  <label>Desde la grabadora
                    <select name="folder" required defaultValue="">
                      <option value="" disabled>Elige una grabación…</option>
                      {pending.map((r) => (
                        <option key={r.folder} value={r.folder}>{fmtDateTime(r.date)} — {r.title}</option>
                      ))}
                    </select>
                  </label>
                  <input name="title" placeholder="Título (opcional)" />
                  <ParticipantsPicker people={pickable} />
                  <Submit pendingText="Enviando…">Asignar y procesar</Submit>
                </ActionForm>
              ) : (
                <p className="small muted">No hay grabaciones nuevas en la carpeta de la grabadora.</p>
              )
            )}
            <details className="sub">
              <summary>Pegar o subir una transcripción</summary>
              <ActionForm action={addMeeting} className="stack" reset>
                <input type="hidden" name="project_id" value={id} />
                <input name="title" placeholder="Título de la reunión" required />
                <input name="meeting_date" type="datetime-local" />
                <textarea name="transcript" rows={6} placeholder="Pega aquí la transcripción…" />
                <label className="small">…o adjunta un archivo .txt / .md
                  <input name="file" type="file" accept=".txt,.md,.vtt,.srt,text/plain" />
                </label>
                <ParticipantsPicker people={pickable} />
                <Submit pendingText="Enviando…">Añadir y procesar</Submit>
              </ActionForm>
            </details>
          </section>

          <section className="card">
            <h3>Personas ({people.length})</h3>
            {people.length === 0 && (
              <p className="muted small">Se añadirán al procesar reuniones.</p>
            )}
            <ul className="people-mini">
              {people.map((p) => (
                <li key={p.id}>
                  <Link href={`/personas?id=${p.id}`} className="person-link">
                    <span className="avatar">{initials(p.name)}</span>
                    <span className="person-link-text">
                      <span className="person-name">{p.name}</span>
                      <span className="muted small">
                        {p.role || [p.job_title, p.company].filter(Boolean).join(" · ") || "Papel sin definir"}
                      </span>
                    </span>
                    {p.open_tasks > 0 && <span className="pill">{p.open_tasks}</span>}
                  </Link>
                  {p.summary && <div className="small person-summary">{p.summary}</div>}
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h3>Reuniones</h3>
            {meetings.length === 0 && <p className="muted small">Sin reuniones todavía.</p>}
            <ul className="meetings">
              {meetings.map((m) => (
                <li key={m.id}>
                  <Link href={`/reuniones/${m.id}`}>{m.title}</Link>
                  <div className="small muted">
                    {fmtDateTime(m.meeting_date)} · {m.source === "grabadora" ? "🎙️ grabadora" : "📝 manual"}
                    {m.status === "procesada" && ` · ${m.changes} cambios`}
                  </div>
                  {m.status !== "procesada" && <Badge status={m.status} />}
                  {m.status === "error" && (
                    <ActionForm action={retryMeeting}>
                      <p className="form-error small">{m.error}</p>
                      <input type="hidden" name="id" value={m.id} />
                      <Submit className="btn small" pendingText="Reintentando…">Reintentar</Submit>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h3>Historial de cambios</h3>
            <ChangeList changes={changes} />
            {project.updated_at && <p className="muted small">Actualizado {fmtDate(project.updated_at)}</p>}
          </section>
        </aside>
      </div>
    </>
  );
}
