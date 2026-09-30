import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Genera un servidor autocontenido (.next/standalone) para la imagen Docker.
  output: "standalone",
  experimental: {
    // Permite subir transcripciones largas y documentos (PDF) desde los formularios.
    serverActions: { bodySizeLimit: "100mb" },
  },
};

export default nextConfig;
