import Link from "next/link";
import type { ChangeRow } from "@/lib/queries";
import { Badge, fmtDateTime } from "./ui";

const ACTION: Record<string, string> = {
  "creado tema": "Nuevo tema",
  "creado tarea": "Nueva tarea",
  "estado tema": "Estado tema",
  "estado tarea": "Estado tarea",
  "actualizado tema": "Tema actualizado",
  "actualizado tarea": "Tarea actualizada",
  "eliminado tema": "Tema eliminado",
  "eliminado tarea": "Tarea eliminada",
  "creado persona": "Nueva persona",
};

export function ChangeList({ changes, showMeeting = true }: { changes: ChangeRow[]; showMeeting?: boolean }) {
  if (!changes.length) return <p className="muted small">Sin cambios registrados.</p>;
  return (
    <ul className="changes">
      {changes.map((c) => (
        <li key={c.id}>
          <div>
            <span className={`tag a-${c.action}`}>{ACTION[`${c.action} ${c.entity}`]}</span>{" "}
            {c.entity === "persona"
              ? <Link href={`/personas?id=${c.entity_id}`}><strong>{c.entity_title}</strong></Link>
              : <strong>{c.entity_title}</strong>}
            {c.action === "estado" && c.old_status && (
              <> <Badge status={c.old_status} /> → <Badge status={c.new_status ?? ""} /></>
            )}
            {c.action === "creado" && c.entity === "tarea" && c.new_status && c.new_status !== "pendiente" && (
              <> <Badge status={c.new_status} /></>
            )}
          </div>
          {c.note && <div className="small">{c.note}</div>}
          {c.evidence && <div className="small evidence">“{c.evidence}”</div>}
          <div className="small muted">
            {fmtDateTime(c.created_at)}
            {showMeeting && (c.meeting_id
              ? <> · <Link href={`/reuniones/${c.meeting_id}`}>{c.meeting_title}</Link></>
              : " · manual")}
          </div>
        </li>
      ))}
    </ul>
  );
}
