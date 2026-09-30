/** Iniciales para el avatar: "Ana García" → "AG". */
export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

/** Etiqueta del tipo de fuente de una reunión. */
export const SOURCE_LABEL: Record<string, string> = {
  grabadora: "🎙️ grabadora",
  manual: "📝 manual",
  correo: "✉️ correo",
  documento: "📄 documento",
};
