import Link from "next/link";
import { analyzeDocument, applyDocumentPlan } from "@/app/actions";
import type { DocPlan } from "@/lib/docplan";
import { ActionForm, Submit } from "./forms";

export type DocPlanRow = { source_key: string; status: string; plan: DocPlan | null; error: string | null };

const CONF_LABEL: Record<string, string> = { alta: "Seguro", media: "Probable", baja: "Posible" };

/** "1, 2, 3, 5" → "1–3, 5" */
export function pageRanges(pages: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(j > i ? `${pages[i]}–${pages[j]}` : String(pages[i]));
    i = j;
  }
  return out.join(", ");
}

function Analyze({ docKey, label, primary }: { docKey: string; label: string; primary?: boolean }) {
  return (
    <ActionForm action={analyzeDocument}>
      <input type="hidden" name="key" value={docKey} />
      <Submit className={`btn small${primary ? " primary" : ""}`} pendingText="Enviando…">{label}</Submit>
    </ActionForm>
  );
}

/** Estado del plan de la IA para un documento y formulario para confirmarlo. */
export function DocPlanState({ row, docKey, projectName }: {
  row: DocPlanRow | undefined; docKey: string; projectName: Map<string, string>;
}) {
  if (!row || row.status === "descartada") {
    return (
      <div className="triage">
        {row && <span className="muted small">Descartado.</span>}
        <Analyze docKey={docKey} label="🤖 Analizar con IA" primary={!row} />
      </div>
    );
  }
  if (row.status === "analizando") {
    return <div className="triage"><span className="pill processing">⏳ La IA está leyendo el documento…</span></div>;
  }
  if (row.status === "error" || !row.plan) {
    return (
      <div className="triage">
        <p className="form-error small">No se pudo analizar: {row.error ?? "sin resultado"}</p>
        <Analyze docKey={docKey} label="Reintentar" />
      </div>
    );
  }
  const plan = row.plan;
  const meta = (
    <div className="muted small">
      {plan.total_pages} página{plan.total_pages === 1 ? "" : "s"}
      {plan.method === "ia" && " · leído con IA (PDF escaneado)"}
    </div>
  );
  if (!plan.items.length) {
    return (
      <div className="triage">
        {meta}
        <div className="small"><strong>La IA no ha encontrado información de ningún proyecto.</strong></div>
        <Analyze docKey={docKey} label="Volver a analizar" />
      </div>
    );
  }
  if (row.status === "aplicada") {
    return <div className="triage">{meta}</div>;
  }
  const hasNew = plan.items.some((i) => !i.project_id);
  return (
    <div className="triage doc-plan">
      {meta}
      <div className="small">
        <strong>{hasNew ? "📋 Propuesta de la IA (incluye proyectos nuevos):" : "📋 Propuesta de la IA:"}</strong>{" "}
        marca lo que quieras incorporar.
      </div>
      <ActionForm action={applyDocumentPlan} className="stack">
        <input type="hidden" name="key" value={docKey} />
        {plan.items.map((it, i) => (
          <div key={i} className="plan-item">
            <label className="check suggestion">
              <input type="checkbox" name="item" value={i} defaultChecked={it.confidence !== "baja"} />
              <span>
                {it.project_id ? (
                  <strong>{projectName.get(it.project_id) ?? `${it.client_name} · ${it.name}`}</strong>
                ) : (
                  <>
                    <span className="tag new">Nuevo proyecto</span>{" "}
                    {!it.client_id && <span className="tag new">Cliente nuevo</span>}
                  </>
                )}{" "}
                <span className={`pill conf-${it.confidence}`}>{CONF_LABEL[it.confidence] ?? it.confidence}</span>
                <span className="muted small"> · pág. {pageRanges(it.pages)}</span>
                <span className="muted small block">{it.reason}</span>
              </span>
            </label>
            {!it.project_id && (
              <div className="plan-new">
                <label className="small">Proyecto
                  <input name={`name_${i}`} defaultValue={it.name} />
                </label>
                <label className="small">Cliente
                  <input name={`client_${i}`} defaultValue={it.client_name} />
                </label>
                {it.description && <p className="muted small">{it.description}</p>}
              </div>
            )}
          </div>
        ))}
        <div className="head-actions">
          <Submit className="btn small primary" pendingText="Enviando…">Incorporar y analizar</Submit>
          <button type="submit" name="op" value="descartar" className="btn small">Descartar</button>
        </div>
      </ActionForm>
      <details className="sub">
        <summary className="small">Otras opciones</summary>
        <p className="small muted">
          Si has creado <Link href="/proyectos">proyectos</Link> después del análisis, vuelve a analizarlo para que los tenga en cuenta.
        </p>
        <Analyze docKey={docKey} label="Volver a analizar" />
      </details>
    </div>
  );
}
