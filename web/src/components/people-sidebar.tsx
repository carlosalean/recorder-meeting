"use client";

import Link from "next/link";
import { useState } from "react";
import { initials } from "@/lib/format";

export type SidebarPerson = {
  id: string; name: string; company: string | null; job_title: string | null; open_tasks: number;
};

/** Listado lateral de personas agrupadas por empresa, con buscador. */
export function PeopleSidebar({ people, selected }: { people: SidebarPerson[]; selected?: string }) {
  const [q, setQ] = useState("");
  const k = q.trim().toLowerCase();
  const shown = k
    ? people.filter((p) => `${p.name} ${p.company ?? ""} ${p.job_title ?? ""}`.toLowerCase().includes(k))
    : people;
  const groups = new Map<string, SidebarPerson[]>();
  for (const p of shown) {
    const g = p.company || "Sin empresa";
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  return (
    <aside className="people-side card">
      <div className="people-side-head">
        <input placeholder="Buscar persona o empresa…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Link href="/personas?nueva=1" className="btn small">+ Nueva</Link>
      </div>
      {shown.length === 0 && <p className="muted small pad">Sin resultados.</p>}
      {[...groups].map(([company, list]) => (
        <div key={company} className="people-group">
          <div className="people-group-title">{company}</div>
          {list.map((p) => (
            <Link key={p.id} href={`/personas?id=${p.id}`}
              className={`person-link ${p.id === selected ? "active" : ""}`}>
              <span className="avatar">{initials(p.name)}</span>
              <span className="person-link-text">
                <span className="person-name">{p.name}</span>
                {p.job_title && <span className="muted small">{p.job_title}</span>}
              </span>
              {p.open_tasks > 0 && <span className="pill">{p.open_tasks}</span>}
            </Link>
          ))}
        </div>
      ))}
    </aside>
  );
}

