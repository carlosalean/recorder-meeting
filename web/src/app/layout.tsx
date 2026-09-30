import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

// Todas las páginas leen de la base de datos en cada petición.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Seguimiento de reuniones",
  description: "Clientes, proyectos, temas y tareas actualizados a partir de las reuniones",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="dot" /> Seguimiento de reuniones
          </Link>
          <nav>
            <Link href="/">Panel</Link>
            <Link href="/proyectos">Proyectos</Link>
            <Link href="/personas">Personas</Link>
            <Link href="/clientes">Clientes</Link>
            <Link href="/grabaciones">Grabaciones</Link>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
