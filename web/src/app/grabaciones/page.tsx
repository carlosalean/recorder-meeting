import Link from "next/link";
import { importRecording } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionForm, Submit } from "@/components/forms";
import { Empty, fmtDateTime } from "@/components/ui";
import { importedFolders, listProjects, processingCount } from "@/lib/queries";
import { listRecordings } from "@/lib/recordings";

export default async function RecordingsPage() {
  const [recordings, imported, projects, processing] = await Promise.all([
    listRecordings(), importedFolders(), listProjects({ status: "activo" }), processingCount(),
  ]);
  const byFolder = new Map(imported.map((i) => [i.source_path, i]));

  return (
    <>
      <AutoRefresh active={processing > 0} />
      <div className="page-head">
        <h1>Grabaciones</h1>
      </div>
      <p className="muted">
        Reuniones grabadas con la aplicación <em>meeting-recorder</em>. Asigna cada una a su proyecto y la IA
        actualizará los temas y tareas.
      </p>

      {!recordings.available ? (
        <Empty>
          No se encuentra la carpeta de grabaciones. Revisa <code>REUNIONES_DIR</code> en el archivo{" "}
          <code>.env</code> y reinicia con <code>docker compose up -d</code>.
        </Empty>
      ) : recordings.items.length === 0 ? (
        <Empty>No hay grabaciones con transcripción todavía.</Empty>
      ) : (
        <div className="table-wrap card"><table className="list">
          <thead>
            <tr><th>Fecha</th><th>Grabación</th><th>Archivos</th><th>Proyecto</th></tr>
          </thead>
          <tbody>
            {recordings.items.map((r) => {
              const done = byFolder.get(r.folder);
              return (
                <tr key={r.folder}>
                  <td className="nowrap">{fmtDateTime(r.date)}</td>
                  <td><strong>{r.title}</strong><div className="muted small">{r.folder}</div></td>
                  <td className="small">
                    {r.audio ? "🎧 audio · " : ""}📝 transcripción{r.hasSummary ? " · 📋 resumen" : ""}
                  </td>
                  <td>
                    {done ? (
                      <>
                        <Link href={`/proyectos/${done.project_id}`}>{done.project_name}</Link>{" · "}
                        <Link href={`/reuniones/${done.id}`}>ver reunión</Link>
                      </>
                    ) : projects.length === 0 ? (
                      <span className="muted small">Crea antes un <Link href="/proyectos">proyecto</Link></span>
                    ) : (
                      <ActionForm action={importRecording} className="inline-form">
                        <input type="hidden" name="folder" value={r.folder} />
                        <select name="project_id" required defaultValue="">
                          <option value="" disabled>Asignar a…</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>{p.client_name} · {p.name}</option>
                          ))}
                        </select>
                        <Submit pendingText="Enviando…">Asignar</Submit>
                      </ActionForm>
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
