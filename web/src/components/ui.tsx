import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { label } from "@/lib/status";

export function Badge({ status }: { status: string }) {
  return <span className={`badge s-${status}`}>{label(status)}</span>;
}

export function Md({ children }: { children: string | null | undefined }) {
  if (!children) return null;
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
}

const dateFmt = new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

export const fmtDate = (d: Date | string | null | undefined) => {
  if (!d) return "—";
  // Las fechas sin hora (YYYY-MM-DD) se muestran tal cual, sin desplazamiento de zona horaria.
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split("-").map(Number);
    return dateFmt.format(new Date(y, m - 1, day));
  }
  return dateFmt.format(new Date(d));
};
export const fmtDateTime = (d: Date | string | null | undefined) => (d ? dateTimeFmt.format(new Date(d)) : "—");

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
