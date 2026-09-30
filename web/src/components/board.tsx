import Link from "next/link";
import { deleteTask, deleteTopic, saveTask, saveTopic, setTaskStatus } from "@/app/actions";
import type { Task, Topic } from "@/lib/queries";
import { LABELS, TASK_STATUSES, TOPIC_STATUSES, isClosedTask } from "@/lib/status";
import { ActionForm, StatusSelect, Submit } from "./forms";
import { Badge, fmtDate } from "./ui";

export function TopicBoard({
  topics,
  tasks,
  editable = false,
  projectId,
}: {
  topics: Topic[];
  tasks: Task[];
  editable?: boolean;
  projectId?: string;
}) {
  const byTopic = new Map<string, Task[]>();
  for (const t of tasks) byTopic.set(t.topic_id, [...(byTopic.get(t.topic_id) ?? []), t]);
  return (
    <div className="topics">
      {topics.map((topic) => (
        <TopicCard key={topic.id} topic={topic} tasks={byTopic.get(topic.id) ?? []} editable={editable} />
      ))}
      {editable && projectId && (
        <details className="add-inline">
          <summary>+ Añadir tema</summary>
          <ActionForm action={saveTopic} className="inline-form" reset>
            <input type="hidden" name="project_id" value={projectId} />
            <input name="title" placeholder="Título del tema" required />
            <input name="description" placeholder="Descripción (opcional)" />
            <Submit>Añadir</Submit>
          </ActionForm>
        </details>
      )}
    </div>
  );
}

function TopicCard({ topic, tasks, editable }: { topic: Topic; tasks: Task[]; editable: boolean }) {
  const open = tasks.filter((t) => !isClosedTask(t.status)).length;
  return (
    <section className={`topic ${topic.status === "cerrado" ? "closed" : ""}`}>
      <header className="topic-head">
        <div>
          <h4>
            {topic.title} <Badge status={topic.status} />
          </h4>
          {topic.description && <p className="muted small">{topic.description}</p>}
        </div>
        <div className="topic-meta">
          <span className="pill">{open} pendiente{open === 1 ? "" : "s"}</span>
          {editable && (
            <details className="menu">
              <summary title="Editar tema">✎</summary>
              <div className="menu-body">
                <ActionForm action={saveTopic} className="stack">
                  <input type="hidden" name="id" value={topic.id} />
                  <label>Título<input name="title" defaultValue={topic.title} required /></label>
                  <label>Descripción<textarea name="description" defaultValue={topic.description ?? ""} rows={2} /></label>
                  <label>Estado
                    <select name="status" defaultValue={topic.status}>
                      {TOPIC_STATUSES.map((s) => <option key={s} value={s}>{LABELS[s]}</option>)}
                    </select>
                  </label>
                  <Submit>Guardar</Submit>
                </ActionForm>
                <ActionForm action={deleteTopic} confirm="¿Eliminar el tema y todas sus tareas?">
                  <input type="hidden" name="id" value={topic.id} />
                  <Submit className="btn danger link" pendingText="Eliminando…">Eliminar tema</Submit>
                </ActionForm>
              </div>
            </details>
          )}
        </div>
      </header>
      {tasks.length > 0 ? (
        <table className="tasks">
          <thead>
            <tr>
              <th className="col-status">Estado</th>
              <th>Tarea</th>
              <th className="col-owner">Responsable</th>
              <th className="col-date">Fecha límite</th>
              <th className="col-src">Última reunión</th>
              {editable && <th className="col-act" />}
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => <TaskRow key={t.id} task={t} editable={editable} />)}
          </tbody>
        </table>
      ) : (
        <p className="muted small pad">Sin tareas{editable ? "" : " con los filtros actuales"}.</p>
      )}
      {editable && (
        <details className="add-inline">
          <summary>+ Añadir tarea</summary>
          <ActionForm action={saveTask} className="inline-form" reset>
            <input type="hidden" name="topic_id" value={topic.id} />
            <input name="title" placeholder="Tarea" required />
            <input name="owner" placeholder="Responsable" />
            <input name="due_date" type="date" />
            <Submit>Añadir</Submit>
          </ActionForm>
        </details>
      )}
    </section>
  );
}

function TaskRow({ task: t, editable }: { task: Task; editable: boolean }) {
  return (
    <tr className={isClosedTask(t.status) ? "done" : ""}>
      <td>
        <StatusSelect key={t.status} value={t.status} options={TASK_STATUSES} labels={LABELS}
          onChangeAction={setTaskStatus.bind(null, t.id)} />
      </td>
      <td className="cell-title">
        <div className="task-title">{t.title}</div>
        {t.description && <div className="muted small">{t.description}</div>}
      </td>
      <td data-label="Responsable">
        {t.owner_person_id ? <Link href={`/personas?id=${t.owner_person_id}`}>{t.owner}</Link>
          : t.owner ?? <span className="muted">Sin asignar</span>}
      </td>
      <td data-label="Fecha límite" className={t.overdue ? "overdue" : ""}>{fmtDate(t.due_date)}</td>
      <td data-label="Última reunión" className="small">
        {t.last_meeting_id ? (
          <Link href={`/reuniones/${t.last_meeting_id}`}>{t.last_meeting_title}</Link>
        ) : <span className="muted">Manual</span>}
      </td>
      {editable && (
        <td className="cell-act">
          <details className="menu">
            <summary title="Editar tarea">✎</summary>
            <div className="menu-body">
              <ActionForm action={saveTask} className="stack">
                <input type="hidden" name="id" value={t.id} />
                <label>Tarea<input name="title" defaultValue={t.title} required /></label>
                <label>Descripción<textarea name="description" defaultValue={t.description ?? ""} rows={2} /></label>
                <label>Responsable<input name="owner" defaultValue={t.owner ?? ""} /></label>
                <label>Fecha límite<input name="due_date" type="date" defaultValue={t.due_date ?? ""} /></label>
                <label>Estado
                  <select name="status" defaultValue={t.status}>
                    {TASK_STATUSES.map((s) => <option key={s} value={s}>{LABELS[s]}</option>)}
                  </select>
                </label>
                <Submit>Guardar</Submit>
              </ActionForm>
              <ActionForm action={deleteTask} confirm="¿Eliminar esta tarea?">
                <input type="hidden" name="id" value={t.id} />
                <Submit className="btn danger link" pendingText="Eliminando…">Eliminar tarea</Submit>
              </ActionForm>
            </div>
          </details>
        </td>
      )}
    </tr>
  );
}
