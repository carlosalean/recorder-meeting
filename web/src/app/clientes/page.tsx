import Link from "next/link";
import { deleteClient, saveClient } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { Empty } from "@/components/ui";
import { type Client, listClients } from "@/lib/queries";

function ClientFields({ c }: { c?: Client }) {
  return (
    <>
      {c && <input type="hidden" name="id" value={c.id} />}
      <label>Nombre *<input name="name" defaultValue={c?.name} required /></label>
      <label>Persona de contacto<input name="contact_name" defaultValue={c?.contact_name ?? ""} /></label>
      <label>Email<input name="email" type="email" defaultValue={c?.email ?? ""} /></label>
      <label>Teléfono<input name="phone" defaultValue={c?.phone ?? ""} /></label>
      <label className="span-2">Notas<textarea name="notes" rows={2} defaultValue={c?.notes ?? ""} /></label>
    </>
  );
}

export default async function ClientsPage() {
  const clients = await listClients();
  return (
    <>
      <div className="page-head"><h1>Clientes</h1></div>

      <details className="card add-card" open={clients.length === 0}>
        <summary>+ Nuevo cliente</summary>
        <ActionForm action={saveClient} className="grid-form" reset>
          <ClientFields />
          <div className="span-2"><Submit>Crear cliente</Submit></div>
        </ActionForm>
      </details>

      {clients.length === 0 ? (
        <Empty>Aún no hay clientes.</Empty>
      ) : (
        <div className="table-wrap card"><table className="list">
          <thead>
            <tr><th>Cliente</th><th>Contacto</th><th>Email</th><th>Teléfono</th><th>Proyectos</th><th /></tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td><strong>{c.name}</strong>{c.notes && <div className="muted small">{c.notes}</div>}</td>
                <td>{c.contact_name ?? "—"}</td>
                <td>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : "—"}</td>
                <td>{c.phone ?? "—"}</td>
                <td><Link href={`/proyectos?cliente=${c.id}`}>{c.project_count} proyecto(s)</Link></td>
                <td className="actions">
                  <details className="menu">
                    <summary title="Editar">✎</summary>
                    <div className="menu-body wide">
                      <ActionForm action={saveClient} className="grid-form">
                        <ClientFields c={c} />
                        <div className="span-2"><Submit>Guardar</Submit></div>
                      </ActionForm>
                      <ActionForm action={deleteClient}
                        confirm={`¿Eliminar ${c.name}? Se borrarán también sus proyectos, reuniones, temas y tareas.`}>
                        <input type="hidden" name="id" value={c.id} />
                        <Submit className="btn danger link" pendingText="Eliminando…">Eliminar cliente</Submit>
                      </ActionForm>
                    </div>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
