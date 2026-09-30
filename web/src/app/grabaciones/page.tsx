import Link from "next/link";
import { autoAssignAll, importRecording } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionForm, Submit } from "@/components/forms";
import { ParticipantsPicker } from "@/components/participants";
import { Empty, fmtDateTime } from "@/components/ui";
import { query } from "@/lib/db";
import { importedFolders, listPeople, listProjects, processingCount } from "@/lib/queries";
import { listRecordings } from "@/lib/recordings";
import { isScanning } from "@/lib/triage";
import { type TriageRow, TriageState } from "@/components/triage-state";

export default async function RecordingsPage() {
  const [recordings, imported, projects, processing, people, triage] = await Promise.all([
    listRecordings(), importedFolders(), listProjects(), processingCount(), listPeople(),
    query<TriageRow>("SELECT * FROM recording_triage"),
  ]);
  const active = projects.filter((p) => p.status !== "cerrado");
  const projectName = new Map(projects.map((p) => [p.id, `${p.client_name} · ${p.name}`]));
  const pickable = people.map((p) => ({ id: p.id, name: p.name, company: p.company }));
  const byFolder = new Map<string, typeof imported>();
  for (const i of imported) byFolder.set(i.source_path, [...(byFolder.get(i.source_path) ?? []), i]);
  const triageBy = new Map(triage.map((t) => [t.folder, t]));
  const pending = recordings.items.filter((r) => !byFolder.has(r.folder));
  const classifying = triage.some((t) => t.status === "clasificando") || isScanning();
  const autoMinutes = Number(process.env.AUTO_ASSIGN_MINUTES ?? "5");

  return (
    <>
      <AutoRefresh active={processing > 0 || classifying} />
      <div className="page-head">
        <div>
          <h1>Grabaciones</h1>
          <p className="muted">
            La IA identifica a qué proyecto pertenece cada grabación y, si lo tiene claro, la asigna y la procesa
            sola{autoMinutes > 0 ? ` (revisa la carpeta cada ${autoMinutes} min)` : ""}. Si duda, te propone
            el proyecto para que lo confirmes. También puedes asignarlas a mano.
          </p>
        </div>
        {pending.length > 0 && active.length > 0 && (
          <ActionForm action={autoAssignAll}>
            <Submit pendingText="Enviando…">🤖 Clasificar pendientes con IA ({pending.length})</Submit>
          </ActionForm>
        )}
      </div>

      {!recordings.available ? (
        <Empty>
          No se encuentra la carpeta de grabaciones. Revisa <code>REUNIONES_DIR</code> en el archivo{" "}
          <code>.env</code> y reinicia con <code>docker compose up -d</code>.
        </Empty>
      ) : recordings.items.length === 0 ? (
        <Empty>No hay grabaciones con transcripción todavía.</Empty>
      ) : (
        <div className="table-wrap card"><table className="list recordings">
          <thead>
            <tr><th>Fecha</th><th>Grabación</th><th>Proyecto</th></tr>
          </thead>
          <tbody>
            {recordings.items.map((r) => {
              const done = byFolder.get(r.folder);
              const t = triageBy.get(r.folder);
              return (
                <tr key={r.folder}>
                  <td className="nowrap">{fmtDateTime(r.date)}</td>
                  <td>
                    <strong>{r.title}</strong>
                    <div className="muted small">
                      {r.audio ? "🎧 audio · " : ""}📝 transcripción{r.hasSummary ? " · 📋 resumen" : ""}
                    </div>
                    {t?.summary && <div className="small triage-summary">{t.summary}</div>}
                  </td>
                  <td className="triage-cell">
                    {done ? (
                      <div className="assigned">
                        {t?.status === "asignada" && <span className="pill ok">🤖 Clasificada con IA</span>}
                        {done.map((d) => (
                          <div key={d.id}>
                            <Link href={`/proyectos/${d.project_id}`}>{projectName.get(d.project_id) ?? d.project_name}</Link>
                            {" · "}<Link href={`/reuniones/${d.id}`}>ver reunión</Link>
                          </div>
                        ))}
                      </div>
                    ) : active.length === 0 ? (
                      <span className="muted small">Crea antes un <Link href="/proyectos">proyecto</Link></span>
                    ) : (
                      <>
                        <TriageState t={t} folder={r.folder} projectName={projectName} />
                        <details className="sub manual">
                          <summary>Asignar a mano</summary>
                          <ActionForm action={importRecording} className="inline-form">
                            <input type="hidden" name="folder" value={r.folder} />
                            <select name="project_id" required defaultValue="">
                              <option value="" disabled>Asignar a…</option>
                              {active.map((p) => (
                                <option key={p.id} value={p.id}>{p.client_name} · {p.name}</option>
                              ))}
                            </select>
                            <Submit pendingText="Enviando…">Asignar</Submit>
                            <ParticipantsPicker people={pickable} />
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
