import Link from "next/link";
import { saveProject } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { Badge, Empty, fmtDate } from "@/components/ui";
import { listClients, listProjects } from "@/lib/queries";
import { LABELS, PROJECT_STATUSES } from "@/lib/status";

export default async function ProjectsPage({ searchParams }: PageProps<"/proyectos">) {
  const sp = await searchParams;
  const clientId = typeof sp.cliente === "string" && sp.cliente ? sp.cliente : undefined;
  const [clients, projects] = await Promise.all([listClients(), listProjects({ clientId })]);

  return (
    <>
      <div className="page-head">
        <h1>Proyectos</h1>
        <form method="get" className="filters compact">
          <select name="cliente" defaultValue={clientId ?? ""}>
            <option value="">Todos los clientes</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn">Filtrar</button>
        </form>
      </div>

      {clients.length === 0 ? (
        <Empty>Primero <Link href="/clientes">crea un cliente</Link>.</Empty>
      ) : (
        <details className="card add-card" open={projects.length === 0}>
          <summary>+ Nuevo proyecto</summary>
          <ActionForm action={saveProject} className="grid-form">
            <label>Cliente *
              <select name="client_id" defaultValue={clientId ?? ""} required>
                <option value="" disabled>Elige un cliente</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label>Nombre *<input name="name" required /></label>
            <label className="span-2">Descripción / objetivo
              <textarea name="description" rows={2}
                placeholder="Ayuda a la IA a entender el contexto del proyecto" />
            </label>
            <label>Estado
              <select name="status" defaultValue="activo">
                {PROJECT_STATUSES.map((s) => <option key={s} value={s}>{LABELS[s]}</option>)}
              </select>
            </label>
            <div className="span-2"><Submit>Crear proyecto</Submit></div>
          </ActionForm>
        </details>
      )}

      {projects.length > 0 && (
        <div className="table-wrap card"><table className="list">
          <thead>
            <tr>
              <th>Proyecto</th><th>Cliente</th><th>Estado</th><th>Temas abiertos</th>
              <th>Tareas pendientes</th><th>Reuniones</th><th>Última reunión</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td><Link href={`/proyectos/${p.id}`}><strong>{p.name}</strong></Link></td>
                <td>{p.client_name}</td>
                <td><Badge status={p.status} /></td>
                <td>{p.open_topics}</td>
                <td>
                  {p.open_tasks}
                  {p.overdue_tasks > 0 && <span className="overdue small"> ({p.overdue_tasks} vencidas)</span>}
                </td>
                <td>{p.meeting_count}</td>
                <td>{fmtDate(p.last_meeting)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
