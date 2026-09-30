import Link from "next/link";
import { autoAssignRecording, confirmTriage } from "@/app/actions";
import type { Suggestion } from "@/lib/triage";
import { ActionForm, Submit } from "./forms";

export type TriageRow = {
  folder: string; status: string; suggestions: Suggestion[]; summary: string | null; error: string | null;
  new_project: { cliente: string; nombre: string; descripcion: string } | null;
};

const CONF_LABEL: Record<string, string> = { alta: "Seguro", media: "Probable", baja: "Posible" };

/** Estado de la asignación automática de una fuente (grabación, hilo de correo o documento). */
export function TriageState({ t, folder, projectName }: {
  t: TriageRow | undefined; folder: string; projectName: Map<string, string>;
}) {
  const retry = (label: string) => (
    <ActionForm action={autoAssignRecording}>
      <input type="hidden" name="folder" value={folder} />
      <Submit className="btn small" pendingText="Enviando…">{label}</Submit>
    </ActionForm>
  );
  if (!t) {
    return <div className="triage">{retry("🤖 Asignar con IA")}</div>;
  }
  if (t.status === "clasificando") {
    return <div className="triage"><span className="pill processing">⏳ La IA está clasificando…</span></div>;
  }
  if (t.status === "error") {
    return (
      <div className="triage">
        <p className="form-error small">No se pudo clasificar: {t.error}</p>
        {retry("Reintentar")}
      </div>
    );
  }
  if (t.status === "dudosa") {
    return (
      <div className="triage">
        <div className="small"><strong>🤔 La IA no está segura.</strong> Marca el proyecto correcto:</div>
        <ActionForm action={confirmTriage} className="stack">
          <input type="hidden" name="folder" value={folder} />
          {t.suggestions.map((s, i) => (
            <label key={s.project_id} className="check suggestion">
              <input type="checkbox" name="project_id" value={s.project_id} defaultChecked={i === 0} />
              <span>
                <strong>{projectName.get(s.project_id) ?? `Proyecto ${s.project_id}`}</strong>{" "}
                <span className={`pill conf-${s.confidence}`}>{CONF_LABEL[s.confidence] ?? s.confidence}</span>
                <span className="muted small"> — {s.reason}</span>
              </span>
            </label>
          ))}
          <div><Submit className="btn small primary" pendingText="Enviando…">Confirmar y procesar</Submit></div>
        </ActionForm>
      </div>
    );
  }
  // sin_proyecto (o asignada pero ya sin reuniones)
  return (
    <div className="triage">
      <div className="small"><strong>No encaja con ningún proyecto.</strong></div>
      {t.new_project && (
        <div className="small">
          Parece un proyecto nuevo: <strong>{t.new_project.nombre}</strong> (cliente {t.new_project.cliente}).{" "}
          <Link href="/proyectos">Créalo</Link> y vuelve a pedir la asignación.
        </div>
      )}
      {retry("Volver a clasificar")}
    </div>
  );
}
