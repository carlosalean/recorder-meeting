import { HIERARCHY_LEVELS, INFLUENCE_LEVELS, PERSON_LABELS } from "@/lib/status";

export type PersonValues = {
  name?: string | null; company?: string | null; job_title?: string | null; department?: string | null;
  hierarchy_level?: string | null; influence?: string | null; reports_to_id?: string | null;
  email?: string | null; phone?: string | null; linkedin?: string | null; notes?: string | null;
  ai_profile?: string | null; aliases?: string[] | null;
};

type Option = { id: string; name: string; company: string | null };

/**
 * Campos de la ficha de una persona. `choices` (al unificar fichas) añade a cada
 * campo de texto las distintas opciones encontradas, que se pueden elegir o editar.
 */
export function PersonFields({
  v = {},
  people,
  excludeIds = [],
  choices,
  showAliases = true,
}: {
  v?: PersonValues;
  people: Option[];
  excludeIds?: string[];
  choices?: Partial<Record<keyof PersonValues, string[]>>;
  showAliases?: boolean;
}) {
  const text = (name: keyof PersonValues, label: string, type = "text", required = false) => {
    const opts = choices?.[name]?.filter(Boolean) ?? [];
    return (
      <label>
        {label}
        {required ? " *" : ""}
        <input name={name} type={type} required={required} defaultValue={(v[name] as string) ?? ""}
          list={opts.length > 1 ? `opt-${name}` : undefined} />
        {opts.length > 1 && (
          <>
            <datalist id={`opt-${name}`}>{opts.map((o) => <option key={o} value={o} />)}</datalist>
            <span className="choices">Opciones: {opts.join(" · ")}</span>
          </>
        )}
      </label>
    );
  };
  return (
    <>
      {text("name", "Nombre", "text", true)}
      {text("company", "Empresa")}
      {text("job_title", "Cargo")}
      {text("department", "Departamento / área")}
      <label>
        Nivel jerárquico
        <select name="hierarchy_level" defaultValue={v.hierarchy_level ?? ""}>
          <option value="">Sin indicar</option>
          {HIERARCHY_LEVELS.map((x) => <option key={x} value={x}>{PERSON_LABELS[x]}</option>)}
        </select>
      </label>
      <label>
        Influencia / capacidad de decisión
        <select name="influence" defaultValue={v.influence ?? ""}>
          <option value="">Sin indicar</option>
          {INFLUENCE_LEVELS.map((x) => <option key={x} value={x}>{PERSON_LABELS[x]}</option>)}
        </select>
      </label>
      <label>
        Reporta a (jefe directo)
        <select name="reports_to_id" defaultValue={v.reports_to_id ?? ""}>
          <option value="">Nadie / sin indicar</option>
          {people.filter((p) => !excludeIds.includes(p.id)).map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.company ? ` · ${p.company}` : ""}</option>
          ))}
        </select>
      </label>
      {text("email", "Email", "email")}
      {text("phone", "Teléfono")}
      {text("linkedin", "LinkedIn", "url")}
      {showAliases && (
        <label className="span-2">
          Otros nombres con los que aparece (separados por comas)
          <input name="aliases" defaultValue={(v.aliases ?? []).join(", ")}
            placeholder="Ej.: Anita, Ana G." />
        </label>
      )}
      <label className="span-2">
        Notas importantes (cómo trabajar con esta persona, preferencias, contexto…)
        <textarea name="notes" rows={4} defaultValue={v.notes ?? ""} />
      </label>
      <label className="span-2">
        Perfil (lo mantiene la IA; puedes corregirlo)
        <textarea name="ai_profile" rows={3} defaultValue={v.ai_profile ?? ""} />
      </label>
    </>
  );
}
