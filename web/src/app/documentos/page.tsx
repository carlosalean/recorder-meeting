import Link from "next/link";
import { assignSource, autoAssignAll, uploadDocuments } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { type DocPlanRow, DocPlanState } from "@/components/doc-plan";
import { ActionForm, Submit } from "@/components/forms";
import { Empty, fmtDateTime } from "@/components/ui";
import { query } from "@/lib/db";
import { DOC_PREFIX, listDocuments } from "@/lib/documents";
import { listProjects, processingCount } from "@/lib/queries";

const KB = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export default async function DocumentsPage() {
  const [docs, projects, processing] = await Promise.all([listDocuments(), listProjects(), processingCount()]);
  const keys = docs.files.map((d) => DOC_PREFIX + d.path);
  const [plans, meetings] = await Promise.all([
    query<DocPlanRow>("SELECT * FROM doc_plans WHERE source_key = ANY($1)", [keys]),
    query<{ source_path: string; id: string; project_id: string }>(
      "SELECT source_path, id, project_id FROM meetings WHERE source_path = ANY($1)", [keys]),
  ]);
  const planBy = new Map(plans.map((t) => [t.source_key, t]));
  const active = projects.filter((p) => p.status !== "cerrado");
  const projectName = new Map(projects.map((p) => [p.id, `${p.client_name} · ${p.name}`]));
  const pending = keys.filter((k) => !meetings.some((m) => m.source_path === k) && !planBy.has(k)).length;
  const busy = processing > 0 || plans.some((t) => t.status === "analizando");

  return (
    <>
      <AutoRefresh active={busy} />
      <div className="page-head">
        <div>
          <h1>Documentos</h1>
          <p className="muted">
            Exportaciones de OneNote, actas, especificaciones… (PDF, Word, <code>.mht</code>, HTML o texto). La IA lee
            cada documento y propone a qué proyectos corresponde cada parte —existentes o <strong>nuevos</strong>, con su
            cliente—; al incorporarlo completa la descripción del proyecto, sus temas, tareas y personas. Si todo encaja
            con seguridad en proyectos que ya existen, lo incorpora sola; si propone crear algo, te pide confirmación.
          </p>
        </div>
        {pending > 0 && (
          <ActionForm action={autoAssignAll}>
            <Submit pendingText="Enviando…">🤖 Analizar pendientes con IA ({pending})</Submit>
          </ActionForm>
        )}
      </div>

      <section className="card upload">
        <h3>Subir documentos</h3>
        <ActionForm action={uploadDocuments} className="inline-form" reset>
          <input type="file" name="files" multiple required accept=".pdf,.docx,.txt,.md,.html,.htm,.mht,.mhtml" />
          <Submit pendingText="Subiendo…">Subir y analizar</Submit>
        </ActionForm>
        <p className="muted small">
          Se guardan en la subcarpeta <code>Subidos</code> de la carpeta de documentos. Los PDF escaneados (o con el texto
          como imagen) también se leen: la IA los transcribe página a página. Recuerda que el contenido se envía a la API
          de Claude: no subas páginas con contraseñas.
        </p>
      </section>

      {!docs.available ? (
        <Empty>
          No se encuentra la carpeta de documentos. Revisa <code>DOCUMENTOS_DIR</code> en el archivo <code>.env</code> y
          reinicia con <code>docker compose up -d</code>.
        </Empty>
      ) : docs.files.length === 0 ? (
        <Empty>No hay documentos todavía. Exporta tus páginas o secciones de OneNote a PDF o Word y súbelas aquí o guárdalas en la carpeta.</Empty>
      ) : (
        <div className="table-wrap card"><table className="list recordings">
          <thead><tr><th>Modificado</th><th>Documento</th><th>Proyecto</th></tr></thead>
          <tbody>
            {docs.files.map((d) => {
              const key = DOC_PREFIX + d.path;
              const plan = planBy.get(key);
              const done = meetings.filter((m) => m.source_path === key);
              return (
                <tr key={d.path}>
                  <td className="nowrap">{fmtDateTime(d.modified)}</td>
                  <td>
                    <strong>{d.name}</strong>
                    <div className="muted small">{d.path} · {d.ext.slice(1).toUpperCase()} · {KB(d.size)}</div>
                    {plan?.plan?.summary && <div className="small triage-summary">{plan.plan.summary}</div>}
                  </td>
                  <td className="triage-cell">
                    {done.length ? (
                      <div className="assigned">
                        {plan?.plan && <DocPlanState row={plan} docKey={key} projectName={projectName} />}
                        {done.map((m) => (
                          <div key={m.id}>
                            <Link href={`/proyectos/${m.project_id}`}>{projectName.get(m.project_id)}</Link>
                            {" · "}<Link href={`/reuniones/${m.id}`}>ver</Link>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <>
                        <DocPlanState row={plan} docKey={key} projectName={projectName} />
                        {active.length > 0 && <details className="sub manual">
                          <summary>Asignar a mano</summary>
                          <ActionForm action={assignSource} className="inline-form">
                            <input type="hidden" name="folder" value={key} />
                            <select name="project_id" required defaultValue="">
                              <option value="" disabled>Asignar a…</option>
                              {active.map((p) => <option key={p.id} value={p.id}>{p.client_name} · {p.name}</option>)}
                            </select>
                            <Submit pendingText="Enviando…">Asignar</Submit>
                          </ActionForm>
                        </details>}
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
