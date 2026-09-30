"use client";

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="card alert">
      <h2>No se pudo cargar la página</h2>
      <p>
        Lo más habitual es que la base de datos todavía esté arrancando o que no se pueda conectar con ella.
        Espera unos segundos y pulsa <strong>Reintentar</strong>.
      </p>
      <p className="small">
        Si el problema continúa, revisa el registro con <code>docker compose logs web</code> y{" "}
        <code>docker compose ps</code> (el servicio <code>db</code> debe aparecer como <em>healthy</em>).
        {error.digest && <> Código del error: <code>{error.digest}</code>.</>}
      </p>
      <button className="btn primary" onClick={() => retry()}>Reintentar</button>
    </div>
  );
}
