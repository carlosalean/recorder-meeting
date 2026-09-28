import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    // Los tests usan una base de datos real: TEST_DATABASE_URL (se vacía en cada ejecución).
    fileParallelism: false,
  },
});
