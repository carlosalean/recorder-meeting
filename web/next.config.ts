import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Genera un servidor autocontenido (.next/standalone) para la imagen Docker.
  output: "standalone",
  experimental: {
    // Permite subir transcripciones largas desde el formulario.
    serverActions: { bodySizeLimit: "20mb" },
  },
};

export default nextConfig;
