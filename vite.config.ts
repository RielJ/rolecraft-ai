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
    server: { port: 5173, proxy: { "/api": `http://localhost:${apiPort}` } },
  };
});
