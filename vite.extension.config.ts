import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin } from "vite";

// Builds the unpacked MV3 extension into dist-extension/ (docs/plans/chrome-extension.md):
// manifest.json, panel.html (side panel), background.js (module service worker) and content.js.

const root = fileURLToPath(new URL("./extension", import.meta.url));
const outDir = fileURLToPath(new URL("./dist-extension", import.meta.url));
const alias = { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) };
const define = { "process.env.NODE_ENV": JSON.stringify("production") };

/** Copies extension/manifest.json to the output root. */
function manifest(): Plugin {
  return {
    name: "hanapbuhay-extension-manifest",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: readFileSync(new URL("./extension/manifest.json", import.meta.url), "utf8"),
      });
    },
  };
}

/**
 * The content script is injected with chrome.scripting, which runs classic scripts only, so it is
 * built on its own as one IIFE with no shared chunks.
 */
function contentScript(): Plugin {
  return {
    name: "hanapbuhay-extension-content-script",
    apply: "build",
    async closeBundle() {
      await build({
        configFile: false,
        root,
        define,
        logLevel: "warn",
        resolve: { alias },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          target: "chrome116",
          lib: {
            entry: "src/content/index.ts",
            formats: ["iife"],
            name: "hanapbuhayContent",
            fileName: () => "content.js",
          },
        },
      });
    },
  };
}

export default defineConfig({
  root,
  define,
  publicDir: false,
  plugins: [react(), tailwindcss(), manifest(), contentScript()],
  resolve: { alias },
  build: {
    outDir,
    emptyOutDir: true,
    target: "chrome116",
    // MV3 extension pages forbid inline scripts; keep every script an external file.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        panel: fileURLToPath(new URL("./extension/panel.html", import.meta.url)),
        background: fileURLToPath(new URL("./extension/src/background/index.ts", import.meta.url)),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
