import Link from "next/link";
import { assignSource, autoAssignAll } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionForm, Submit } from "@/components/forms";
import { type TriageRow, TriageState } from "@/components/triage-state";
import { Empty, fmtDateTime } from "@/components/ui";
import { query } from "@/lib/db";
import { DOC_PREFIX, listDocuments } from "@/lib/documents";
import { listProjects, processingCount } from "@/lib/queries";

const KB = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export default async function DocumentsPage() {
  const [docs, projects, processing] = await Promise.all([listDocuments(), listProjects(), processingCount()]);
  const keys = docs.files.map((d) => DOC_PREFIX + d.path);
  const [triage, meetings] = await Promise.all([
    query<TriageRow>("SELECT * FROM recording_triage WHERE folder = ANY($1)", [keys]),
    query<{ source_path: string; id: string; project_id: string }>(
      "SELECT source_path, id, project_id FROM meetings WHERE source_path = ANY($1)", [keys]),
  ]);
  const triageBy = new Map(triage.map((t) => [t.folder, t]));
  const active = projects.filter((p) => p.status !== "cerrado");
  const projectName = new Map(projects.map((p) => [p.id, `${p.client_name} · ${p.name}`]));
  const pending = keys.filter((k) => !meetings.some((m) => m.source_path === k) && !triageBy.has(k)).length;
  const busy = processing > 0 || triage.some((t) => t.status === "clasificando");

  return (
    <>
      <AutoRefresh active={busy} />
      <div className="page-head">
        <div>
          <h1>Documentos</h1>
          <p className="muted">
            Exportaciones de OneNote, actas, especificaciones… (PDF, Word, <code>.mht</code>, HTML o texto) que dejes
            en la carpeta de documentos (<code>DOCUMENTOS_DIR</code>). La IA identifica a qué proyectos corresponde
            cada uno —un documento puede repartirse entre varios— y extrae temas, tareas y personas.
          </p>
        </div>
        {pending > 0 && active.length > 0 && (
          <ActionForm action={autoAssignAll}>
            <Submit pendingText="Enviando…">🤖 Clasificar pendientes con IA ({pending})</Submit>
          </ActionForm>
        )}
      </div>

      {!docs.available ? (
        <Empty>
          No se encuentra la carpeta de documentos. Revisa <code>DOCUMENTOS_DIR</code> en el archivo <code>.env</code> y
          reinicia con <code>docker compose up -d</code>.
        </Empty>
      ) : docs.files.length === 0 ? (
        <Empty>No hay documentos todavía. Exporta tus páginas o secciones de OneNote a PDF o Word y guárdalas en la carpeta.</Empty>
      ) : (
        <div className="table-wrap card"><table className="list recordings">
          <thead><tr><th>Modificado</th><th>Documento</th><th>Proyecto</th></tr></thead>
          <tbody>
            {docs.files.map((d) => {
              const key = DOC_PREFIX + d.path;
              const tr = triageBy.get(key);
              const done = meetings.filter((m) => m.source_path === key);
              return (
                <tr key={d.path}>
                  <td className="nowrap">{fmtDateTime(d.modified)}</td>
                  <td>
                    <strong>{d.name}</strong>
                    <div className="muted small">{d.path} · {d.ext.slice(1).toUpperCase()} · {KB(d.size)}</div>
                    {tr?.summary && <div className="small triage-summary">{tr.summary}</div>}
                  </td>
                  <td className="triage-cell">
                    {done.length ? (
                      <div className="assigned">
                        {done.map((m) => (
                          <div key={m.id}>
                            <Link href={`/proyectos/${m.project_id}`}>{projectName.get(m.project_id)}</Link>
                            {" · "}<Link href={`/reuniones/${m.id}`}>ver</Link>
                          </div>
                        ))}
                      </div>
                    ) : active.length === 0 ? (
                      <span className="muted small">Crea antes un <Link href="/proyectos">proyecto</Link></span>
                    ) : (
                      <>
                        <TriageState t={tr} folder={key} projectName={projectName} />
                        <details className="sub manual">
                          <summary>Asignar a mano</summary>
                          <ActionForm action={assignSource} className="inline-form">
                            <input type="hidden" name="folder" value={key} />
                            <select name="project_id" required defaultValue="">
                              <option value="" disabled>Asignar a…</option>
                              {active.map((p) => <option key={p.id} value={p.id}>{p.client_name} · {p.name}</option>)}
                            </select>
                            <Submit pendingText="Enviando…">Asignar</Submit>
                          </ActionForm>
                        </details>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </>
  );
}
