import Link from "next/link";
import { applyReorg, startReorg } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { ActionForm, Submit } from "@/components/forms";
import { Empty, fmtDateTime } from "@/components/ui";
import { one, query } from "@/lib/db";
import { listClients } from "@/lib/queries";
import type { Proposal } from "@/lib/reorg";

type Run = { id: string; status: string; diagnosis: string | null; error: string | null; created_at: Date };
type Row = { id: string; kind: string; payload: Proposal; reason: string; status: string; error: string | null };

const KIND_LABEL: Record<string, string> = {
  mover_tema: "Mover tema", mover_tarea: "Mover tarea", mover_reunion: "Mover reunión",
  fusionar_temas: "Fusionar temas", fusionar_proyectos: "Fusionar proyectos", renombrar_tema: "Renombrar tema",
};

export default async function ReorgPage() {
  const [clients, run] = await Promise.all([
    listClients(),
    one<Run>("SELECT * FROM reorg_runs ORDER BY id DESC LIMIT 1"),
  ]);
  const proposals = run
    ? await query<Row>("SELECT id, kind, payload, reason, status, error FROM reorg_proposals WHERE run_id = $1 ORDER BY id", [run.id])
    : [];

  // Nombres actuales para describir cada propuesta.
  const [projects, topics, tasks, meetings] = await Promise.all([
    query<{ id: string; name: string }>("SELECT id, name FROM projects"),
    query<{ id: string; title: string; project_id: string }>("SELECT id, title, project_id FROM topics"),
    query<{ id: string; title: string; topic_id: string }>("SELECT id, title, topic_id FROM tasks"),
    query<{ id: string; title: string; project_id: string }>("SELECT id, title, project_id FROM meetings"),
  ]);
  const P = new Map(projects.map((p) => [Number(p.id), p.name]));
  const T = new Map(topics.map((t) => [Number(t.id), t]));
  const K = new Map(tasks.map((k) => [Number(k.id), k]));
  const R = new Map(meetings.map((m) => [Number(m.id), m]));
  const proj = (id: number | null | undefined) => (id != null ? <Link href={`/proyectos/${id}`}>{P.get(id) ?? `proyecto #${id}`}</Link> : "—");
  const topic = (id: number | null | undefined) => (id != null ? `«${T.get(id)?.title ?? `tema #${id}`}»` : "—");

  const describe = (x: Proposal) => {
    switch (x.tipo) {
      case "mover_tema":
        return <>Tema {topic(x.tema_id)} de {proj(Number(T.get(x.tema_id!)?.project_id))} → {proj(x.proyecto_destino_id)}</>;
      case "mover_tarea": {
        const k = K.get(x.tarea_id!);
        const from = k ? T.get(Number(k.topic_id)) : undefined;
        return (
          <>
            Tarea «{k?.title ?? `#${x.tarea_id}`}» (tema {topic(from ? Number(k!.topic_id) : null)} de {proj(Number(from?.project_id))}) →{" "}
            {x.tema_destino_id != null
              ? <>tema {topic(x.tema_destino_id)} de {proj(Number(T.get(x.tema_destino_id)?.project_id))}</>
              : <>nuevo tema «{x.nuevo_titulo}» en {proj(x.proyecto_destino_id)}</>}
          </>
        );
      }
      case "mover_reunion": {
        const m = R.get(x.reunion_id!);
        return <>Reunión <Link href={`/reuniones/${x.reunion_id}`}>«{m?.title ?? `#${x.reunion_id}`}»</Link> de {proj(Number(m?.project_id))} → {proj(x.proyecto_destino_id)}</>;
      }
      case "fusionar_temas":
        return <>{x.temas_ids.map((t) => topic(t)).join(" + ")} → {x.nuevo_titulo ? `«${x.nuevo_titulo}»` : topic(x.temas_ids[0])}</>;
      case "fusionar_proyectos":
        return <>{proj(x.proyecto_origen_id)} se integra en {proj(x.proyecto_destino_id)}</>;
      case "renombrar_tema":
        return <>{topic(x.tema_id)} → «{x.nuevo_titulo}»</>;
      default:
        return x.tipo;
    }
  };

  const pending = proposals.filter((p) => p.status === "pendiente");
  const done = proposals.filter((p) => p.status !== "pendiente");

  return (
    <>
      <AutoRefresh active={run?.status === "analizando"} />
      <div className="page-head">
        <div>
          <h1>Reorganizar con IA</h1>
          <p className="muted">
            La IA revisa todos los proyectos (temas, tareas y reuniones) y propone cambios: información de un proyecto
            metida en otro, temas o proyectos duplicados, reuniones asignadas al proyecto equivocado… Nada se aplica
            hasta que tú lo confirmes, y cada cambio queda en el historial de los proyectos.
          </p>
        </div>
        <ActionForm action={startReorg} className="inline-form">
          <select name="client_id" defaultValue="">
            <option value="">Todos los clientes</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Submit pendingText="Enviando…">🤖 Analizar organización</Submit>
        </ActionForm>
      </div>

      {!run ? (
        <Empty>Todavía no se ha hecho ningún análisis.</Empty>
      ) : run.status === "analizando" ? (
        <div className="card alert info">⏳ La IA está revisando todos los proyectos. Puede tardar unos minutos; la página se actualiza sola.</div>
      ) : run.status === "error" ? (
        <div className="card alert"><strong>El análisis falló:</strong> {run.error}</div>
      ) : (
        <>
          <section className="card">
            <h3>Diagnóstico <span className="muted small">· {fmtDateTime(run.created_at)}</span></h3>
            <p>{run.diagnosis}</p>
          </section>

          {pending.length === 0 && done.length === 0 && <Empty>La IA no ha encontrado nada que reorganizar. 👍</Empty>}

          {pending.length > 0 && (
            <ActionForm action={applyReorg} className="card stack">
              <h3>Propuestas pendientes ({pending.length})</h3>
              <ul className="reorg-list">
                {pending.map((p) => (
                  <li key={p.id}>
                    <label className="check">
                      <input type="checkbox" name="proposal" value={p.id} defaultChecked />
                      <span>
                        <span className={`tag k-${p.kind}`}>{KIND_LABEL[p.kind] ?? p.kind}</span>{" "}
                        {describe(p.payload)}
                        <div className="small muted">{p.reason}</div>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="inline-form">
                <Submit pendingText="Aplicando…">Aplicar las marcadas</Submit>
                <button className="btn" name="op" value="descartar">Descartar las marcadas</button>
              </div>
            </ActionForm>
          )}

          {done.length > 0 && (
            <details className="card">
              <summary><strong>Ya revisadas ({done.length})</strong></summary>
              <ul className="reorg-list">
                {done.map((p) => (
                  <li key={p.id} className={`st-${p.status}`}>
                    <span className="pill">{p.status === "aplicada" ? "✅ Aplicada" : p.status === "error" ? "⚠️ Error" : "Descartada"}</span>{" "}
                    <span className="tag">{KIND_LABEL[p.kind] ?? p.kind}</span> <span className="small muted">{p.reason}</span>
                    {p.error && <div className="form-error small">{p.error}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </>
  );
}
