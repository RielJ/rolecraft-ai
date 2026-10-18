import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Dev: the API runs on PORT (default 3000) and Vite proxies /api to it. Vite runs under Node,
  // which does not read .env the way Bun does, so read it here; the shell's PORT still wins.
  const apiPort = process.env.PORT ?? loadEnv(mode, process.cwd(), "").PORT ?? "3000";
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    build: { outDir: "dist", emptyOutDir: true },
    server: {
      port: 5173,
      // changeOrigin stays false (Vite's string shorthand turns it on): the API's Origin check
      // compares Origin with Host, so Host must stay localhost:5173 or every write is a 403.
      proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: false } },
    },
  };
});
