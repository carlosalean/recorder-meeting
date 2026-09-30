import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteMeeting, retryMeeting } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { ChangeList } from "@/components/changes";
import { ActionForm, Submit } from "@/components/forms";
import { Badge, Md, fmtDateTime } from "@/components/ui";
import { getMeeting, listChanges, meetingPeople } from "@/lib/queries";
import { SOURCE_LABEL, initials } from "@/lib/format";

export default async function MeetingPage({ params }: PageProps<"/reuniones/[id]">) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const m = await getMeeting(id);
  if (!m) notFound();
  const [changes, people] = await Promise.all([listChanges({ meetingId: id }), meetingPeople(id)]);

  return (
    <>
      <AutoRefresh active={m.status === "procesando"} />
      <div className="page-head">
        <div>
          <div className="muted">
            {m.client_name} · <Link href={`/proyectos/${m.project_id}`}>{m.project_name}</Link>
          </div>
          <h1>{m.title} {m.status !== "procesada" && <Badge status={m.status} />}</h1>
          <div className="muted small">
            {fmtDateTime(m.meeting_date)} · {SOURCE_LABEL[m.source] ?? m.source}{m.source_path ? ` · ${m.source_path.replace(/^(correo|doc):/, "")}` : ""}
          </div>
        </div>
        <ActionForm action={deleteMeeting}
          confirm="¿Eliminar esta reunión? Los temas y tareas que creó se conservan.">
          <input type="hidden" name="id" value={m.id} />
          <Submit className="btn danger" pendingText="Eliminando…">Eliminar reunión</Submit>
        </ActionForm>
      </div>

      {m.scope_note && (
        <div className="card alert info small">🔀 {m.scope_note}</div>
      )}

      {m.status === "error" && (
        <div className="card alert">
          <p><strong>No se pudo procesar:</strong> {m.error}</p>
          <ActionForm action={retryMeeting}>
            <input type="hidden" name="id" value={m.id} />
            <Submit pendingText="Reintentando…">Reintentar</Submit>
          </ActionForm>
        </div>
      )}
      {m.status === "procesando" && (
        <div className="card alert info">
          ⏳ La IA está analizando la transcripción. Esta página se actualizará sola al terminar.
        </div>
      )}

      {m.audio_file && (
        <section className="card">
          <h3>Grabación</h3>
          <audio controls preload="none" src={`/api/audio/${m.id}`} style={{ width: "100%" }} />
        </section>
      )}

      <div className="two-col">
        <div>
          {m.ai_summary && (
            <section className="card">
              <h2>Resumen</h2>
              <Md>{m.ai_summary}</Md>
            </section>
          )}
          {m.recorder_summary && (
            <details className="card">
              <summary><strong>Resumen generado por la grabadora</strong></summary>
              <Md>{m.recorder_summary}</Md>
            </details>
          )}
          <details className="card">
            <summary><strong>{m.source === "correo" ? "Correos del hilo" : m.source === "documento" ? "Texto del documento" : "Transcripción completa"}</strong></summary>
            <pre className="transcript">{m.transcript}</pre>
          </details>
        </div>
        <aside>
          <section className="card">
            <h3>Participantes ({people.length})</h3>
            {people.length === 0 && <p className="muted small">Sin participantes identificados.</p>}
            <ul className="people-mini">
              {people.map((p) => (
                <li key={p.id}>
                  <Link href={`/personas?id=${p.id}`} className="person-link">
                    <span className="avatar">{initials(p.name)}</span>
                    <span className="person-link-text">
                      <span className="person-name">{p.name}</span>
                      <span className="muted small">{[p.job_title, p.company].filter(Boolean).join(" · ")}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h3>Cambios aplicados al proyecto ({changes.length})</h3>
            <ChangeList changes={changes} showMeeting={false} />
          </section>
        </aside>
      </div>
    </>
  );
}
