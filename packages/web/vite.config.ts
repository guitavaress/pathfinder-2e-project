import { fileURLToPath } from "node:url";
import type { ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// IPv4 explícito: no WSL2/Node 17+, "localhost" pode resolver para ::1 (IPv6)
// e o proxy não alcançar o backend, devolvendo 500. 127.0.0.1 evita isso.
const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:3001";

const apiProxy: ProxyOptions = {
  target: BACKEND,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("error", (err, req) => {
      console.error(`[proxy] erro em ${req.url}: ${err.message} (backend: ${BACKEND})`);
    });
  },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@pf2e/shared": fileURLToPath(
        new URL("../shared/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Encaminha as chamadas de API para o backend do GM.
      "/character": apiProxy,
      "/scene": apiProxy,
      "/health": apiProxy,
    },
  },
});
