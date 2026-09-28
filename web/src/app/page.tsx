import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { TopicBoard } from "@/components/board";
import { Badge, Empty, fmtDate } from "@/components/ui";
import { getBoard, listClients, listOwners, listProjects, processingCount } from "@/lib/queries";
import { isClosedTask } from "@/lib/status";

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function Dashboard({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const filters = {
    cliente: one(sp.cliente),
    proyecto: one(sp.proyecto),
    responsable: one(sp.responsable),
    q: one(sp.q),
    todas: one(sp.todas) === "1",
  };

  const [clients, owners, allProjects, processing] = await Promise.all([
    listClients(), listOwners(),
    listProjects({ clientId: filters.cliente, status: filters.todas ? undefined : "activo" }),
    processingCount(),
  ]);
  const projects = filters.proyecto ? allProjects.filter((p) => p.id === filters.proyecto) : allProjects;
  const { topics, tasks } = await getBoard(projects.map((p) => p.id), {
    onlyOpen: !filters.todas, owner: filters.responsable, q: filters.q,
  });
  const taskFilter = Boolean(filters.responsable || filters.q);

  const openTasks = tasks.filter((t) => !isClosedTask(t.status));
  const stats = [
    { label: "Proyectos", value: projects.length },
    { label: "Temas abiertos", value: topics.filter((t) => t.status === "abierto").length },
    { label: "Tareas pendientes", value: openTasks.length },
    { label: "Bloqueadas", value: openTasks.filter((t) => t.status === "bloqueada").length, tone: "warn" },
    { label: "Vencidas", value: openTasks.filter((t) => t.overdue).length, tone: "bad" },
  ];

  return (
    <>
      <AutoRefresh active={processing > 0} />
      <div className="page-head">
        <h1>Panel de proyectos</h1>
        {processing > 0 && <span className="pill processing">⏳ Procesando {processing} reunión(es)…</span>}
      </div>

      <form className="filters" method="get">
        <select name="cliente" defaultValue={filters.cliente ?? ""}>
          <option value="">Todos los clientes</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select name="proyecto" defaultValue={filters.proyecto ?? ""}>
          <option value="">Todos los proyectos</option>
          {allProjects.map((p) => <option key={p.id} value={p.id}>{p.client_name} · {p.name}</option>)}
        </select>
        <select name="responsable" defaultValue={filters.responsable ?? ""}>
          <option value="">Todos los responsables</option>
          {owners.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <input name="q" placeholder="Buscar tarea o tema…" defaultValue={filters.q ?? ""} />
        <label className="check">
          <input type="checkbox" name="todas" value="1" defaultChecked={filters.todas} /> Incluir cerrados
        </label>
        <button className="btn">Filtrar</button>
        <Link href="/" className="btn link">Limpiar</Link>
      </form>

      <div className="stats">
        {stats.map((s) => (
          <div key={s.label} className={`stat ${s.value && s.tone ? s.tone : ""}`}>
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {projects.length === 0 ? (
        <Empty>
          No hay proyectos {filters.todas ? "" : "activos "}todavía.{" "}
          <Link href="/clientes">Crea un cliente</Link> y después <Link href="/proyectos">un proyecto</Link>.
        </Empty>
      ) : (
        projects.map((p) => {
          const pTopics = topics.filter((t) => t.project_id === p.id);
          const ids = new Set(pTopics.map((t) => t.id));
          const pTasks = tasks.filter((t) => ids.has(t.topic_id));
          // Con filtro de tareas, ocultar temas (y proyectos) sin coincidencias.
          const shownTopics = taskFilter ? pTopics.filter((t) => pTasks.some((k) => k.topic_id === t.id)) : pTopics;
          if (taskFilter && !shownTopics.length) return null;
          return (
            <section key={p.id} className="project card">
              <header className="project-head">
                <div>
                  <div className="muted small">{p.client_name}</div>
                  <h2><Link href={`/proyectos/${p.id}`}>{p.name}</Link> <Badge status={p.status} /></h2>
                </div>
                <div className="project-meta">
                  <span>{p.open_tasks} tareas pendientes</span>
                  {p.overdue_tasks > 0 && <span className="overdue">{p.overdue_tasks} vencidas</span>}
                  <span>{p.meeting_count} reuniones · última {fmtDate(p.last_meeting)}</span>
                </div>
              </header>
              {shownTopics.length ? (
                <TopicBoard topics={shownTopics} tasks={pTasks} />
              ) : (
                <p className="muted pad">
                  Sin temas abiertos. <Link href={`/proyectos/${p.id}`}>Añade una reunión</Link> para empezar.
                </p>
              )}
            </section>
          );
        })
      )}
    </>
  );
}
