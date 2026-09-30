import Link from "next/link";
import { assignSource, classifyEmails, importEmails } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionForm, Submit } from "@/components/forms";
import { type TriageRow, TriageState } from "@/components/triage-state";
import { Empty, fmtDate } from "@/components/ui";
import { query } from "@/lib/db";
import { THREAD_PREFIX, listPstFiles, listThreadsWithState, threadStats } from "@/lib/emails";
import { listProjects } from "@/lib/queries";

const ESTADOS: [string, string][] = [
  ["pendiente", "Sin clasificar"], ["dudosa", "La IA duda"], ["asignada", "Asignados"],
  ["sin_proyecto", "Sin proyecto"], ["error", "Con error"], ["todos", "Todos"],
];
const PAGE = 50;

export default async function EmailsPage({ searchParams }: PageProps<"/correos">) {
  const sp = await searchParams;
  const estado = typeof sp.estado === "string" ? sp.estado : "pendiente";
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const page = Math.max(Number(sp.p) || 1, 1);

  const [pst, stats, threads, projects] = await Promise.all([
    listPstFiles(), threadStats(),
    listThreadsWithState({ estado, q: q || undefined, limit: PAGE, offset: (page - 1) * PAGE }),
    listProjects(),
  ]);
  const keys = threads.map((t) => THREAD_PREFIX + t.thread_key);
  const [triage, meetings] = await Promise.all([
    query<TriageRow>("SELECT * FROM recording_triage WHERE folder = ANY($1)", [keys]),
    query<{ source_path: string; id: string; project_id: string }>(
      "SELECT source_path, id, project_id FROM meetings WHERE source_path = ANY($1)", [keys]),
  ]);
  const triageBy = new Map(triage.map((t) => [t.folder, t]));
  const active = projects.filter((p) => p.status !== "cerrado");
  const projectName = new Map(projects.map((p) => [p.id, `${p.client_name} · ${p.name}`]));
  const count = Object.fromEntries(stats.map((s) => [s.status, s.n]));
  const total = stats.reduce((a, s) => a + s.n, 0);
  const busy = pst.files.some((f) => f.status === "importando") || (count.clasificando ?? 0) > 0;
  const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const qs = (o: Record<string, string | number>) =>
    "?" + new URLSearchParams({ estado, ...(q ? { q } : {}), ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) });

  return (
    <>
      <AutoRefresh active={busy} everyMs={5000} />
      <div className="page-head">
        <div>
          <h1>Correos</h1>
          <p className="muted">
            Importa tu exportación de Outlook (<code>.pst</code>) y la IA asignará cada hilo de correo a su proyecto,
            extrayendo tareas, pendientes, compromisos y personas, igual que con las reuniones.
          </p>
        </div>
      </div>

      <section className="card">
        <h3>1. Archivos de correo</h3>
        {!pst.available ? (
          <p className="muted small">
            No se encuentra la carpeta de correos. Revisa <code>CORREOS_DIR</code> en el archivo <code>.env</code> y
            reinicia con <code>docker compose up -d</code>.
          </p>
        ) : pst.files.length === 0 ? (
          <p className="muted small">Copia tu archivo <code>.pst</code> en la carpeta de correos (<code>CORREOS_DIR</code>).</p>
        ) : (
          <ul className="meetings">
            {pst.files.map((f) => (
              <li key={f.file}>
                <strong>{f.file}</strong> <span className="muted small">({(f.size / 1_048_576).toFixed(0)} MB)</span>
                <div className="small">
                  {f.status === "importando" && <span className="pill processing">⏳ Importando… {f.emails} correos</span>}
                  {f.status === "importado" && <span className="pill ok">✅ {f.emails} correos importados{f.since ? ` desde ${fmtDate(f.since)}` : ""}</span>}
                  {f.status === "error" && <span className="form-error">Error: {f.error}</span>}
                </div>
                {f.status !== "importando" && (
                  <ActionForm action={importEmails} className="inline-form">
                    <input type="hidden" name="file" value={f.file} />
                    <label className="small">Importar correos desde
                      <input type="date" name="since" defaultValue={f.since ?? yearAgo} />
                    </label>
                    <Submit className="btn small" pendingText="Enviando…">{f.status ? "Volver a importar" : "Importar"}</Submit>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">
          Se omiten papelera, correo no deseado, calendario, contactos y remitentes automáticos (no-reply, boletines…).
          Volver a importar no duplica correos.
        </p>
      </section>

      {total > 0 && (
        <section className="card">
          <h3>2. Clasificar con IA</h3>
          <div className="stats">
            {ESTADOS.slice(0, 5).map(([k, l]) => (
              <Link key={k} href={qs({ estado: k, p: 1 }).replace(/estado=[^&]*/, `estado=${k}`)} className="stat">
                <div className="stat-value">{count[k] ?? 0}</div><div className="stat-label">{l}</div>
              </Link>
            ))}
          </div>
          {(count.pendiente ?? 0) > 0 && active.length > 0 && (
            <ActionForm action={classifyEmails} className="inline-form">
              <label className="small">Hilos a clasificar
                <input type="number" name="limit" min={1} max={2000} defaultValue={Math.min(count.pendiente, 100)} />
              </label>
              <Submit pendingText="Enviando…">🤖 Clasificar con IA</Submit>
              <span className="muted small">
                Se analizan en lotes de 20 hilos. Los que la IA tenga claros se asignan y procesan solos.
              </span>
            </ActionForm>
          )}
        </section>
      )}

      {total > 0 && (
        <>
          <form className="filters" method="get">
            <select name="estado" defaultValue={estado}>
              {ESTADOS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input name="q" placeholder="Buscar por asunto o remitente…" defaultValue={q} />
            <button className="btn">Filtrar</button>
          </form>
          {threads.length === 0 ? <Empty>No hay hilos con este filtro.</Empty> : (
            <div className="table-wrap card"><table className="list recordings">
              <thead><tr><th>Último correo</th><th>Hilo</th><th>Proyecto</th></tr></thead>
              <tbody>
                {threads.map((t) => {
                  const key = THREAD_PREFIX + t.thread_key;
                  const tr = triageBy.get(key);
                  const done = meetings.filter((m) => m.source_path === key);
                  return (
                    <tr key={t.thread_key}>
                      <td className="nowrap">{fmtDate(t.last_at)}</td>
                      <td>
                        <strong>{t.subject}</strong>
                        <div className="muted small">{t.emails} correo(s) · {t.senders.filter(Boolean).join(", ")}</div>
                        {tr?.summary && <div className="small triage-summary">{tr.summary}</div>}
                      </td>
                      <td className="triage-cell">
                        {done.length ? (
                          <div className="assigned">
                            {done.map((d) => (
                              <div key={d.id}>
                                <Link href={`/proyectos/${d.project_id}`}>{projectName.get(d.project_id)}</Link>
                                {" · "}<Link href={`/reuniones/${d.id}`}>ver</Link>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <>
                            {tr && <TriageState t={tr} folder={key} projectName={projectName} />}
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
          <div className="inline-form">
            {page > 1 && <Link className="btn" href={qs({ p: page - 1 })}>← Anteriores</Link>}
            {threads.length === PAGE && <Link className="btn" href={qs({ p: page + 1 })}>Siguientes →</Link>}
          </div>
        </>
      )}
    </>
  );
}
