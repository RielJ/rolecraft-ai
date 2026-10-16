import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: the API runs on PORT (default 3000) and Vite proxies /api to it.
const apiPort = process.env.PORT ?? "3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": `http://localhost:${apiPort}` } },
});
