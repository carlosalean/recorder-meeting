"use client";

import { useState } from "react";

export type PickPerson = { id: string; name: string; company: string | null; inProject?: boolean };

/**
 * Selección opcional de participantes al subir una reunión: casillas para las
 * personas conocidas y un cuadro de texto para las nuevas. Si no se indica nada,
 * la IA los deduce de la conversación.
 */
export function ParticipantsPicker({ people }: { people: PickPerson[] }) {
  const [q, setQ] = useState("");
  const [count, setCount] = useState(0);
  const k = q.trim().toLowerCase();
  const sorted = [...people].sort((a, b) => Number(!!b.inProject) - Number(!!a.inProject));
  return (
    <details className="sub participants">
      <summary>
        Participantes (opcional){count > 0 && <span className="pill">{count} seleccionados</span>}
      </summary>
      <p className="muted small">
        Ayuda a la IA a identificar a las personas. Si lo dejas vacío, las deduce de la conversación.
      </p>
      {people.length > 0 && (
        <>
          <input placeholder="Buscar persona…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div
            className="pick-list"
            onChange={(e) => {
              const box = (e.currentTarget as HTMLElement).querySelectorAll("input:checked");
              setCount(box.length);
            }}
          >
            {sorted.map((p) => {
              const hidden = k && !`${p.name} ${p.company ?? ""}`.toLowerCase().includes(k);
              return (
                <label key={p.id} className="check" style={hidden ? { display: "none" } : undefined}>
                  <input type="checkbox" name="people" value={p.id} />
                  <span>
                    {p.name}
                    {p.company && <span className="muted small"> · {p.company}</span>}
                    {p.inProject && <span className="muted small"> · en el proyecto</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}
      <label className="small">
        Personas nuevas (una por línea: nombre, empresa, cargo)
        <textarea name="new_people" rows={2} placeholder={"Laura Pérez, ACME, Directora de IT"} />
      </label>
    </details>
  );
}
