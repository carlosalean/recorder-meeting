export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  const { ensureSchema } = await import("./lib/db");
  // La base de datos puede tardar en aceptar conexiones (sobre todo la primera vez
  // que se crea el contenedor): se reintenta durante ~1 minuto. Si aun así falla,
  // el servidor arranca igualmente y lo reintentará en la primera petición.
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await ensureSchema();
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[db] base de datos no disponible (intento ${attempt}/30): ${msg}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error("[db] no se pudo preparar la base de datos; se reintentará en la próxima petición");
}
