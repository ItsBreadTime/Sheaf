import { resolve } from "node:path";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

export default defineConfig(({ mode }) => ({
  base: "./",
  test: {
    // The *.manual.test.ts files call live providers and read credentials; they
    // must not run as part of `npm test` (see `npm run test:manual`).
    exclude: [...configDefaults.exclude, "**/*.manual.test.ts"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Packaged builds ship no sourcemaps (they would disclose the full
    // source); use `npm run build:dev` for a debuggable build.
    sourcemap: mode !== "production",
    rolldownOptions: {
      input: {
        action: resolve(import.meta.dirname, "action.html"),
        finder: resolve(import.meta.dirname, "finder.html"),
        "service-worker": resolve(
          import.meta.dirname,
          "src/background/service-worker.ts",
        ),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "service-worker"
            ? "service-worker.js"
            : "assets/[name]-[hash].js",
        chunkFileNames: "assets/chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));
