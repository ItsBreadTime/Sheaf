import { defineConfig } from "vitest/config";

// The manual suite calls live providers and embeddings and needs credentials in
// the environment, so it is excluded from `npm test` and run on demand with
// `npm run test:manual`. Without the relevant keys every case skips.
export default defineConfig({
  test: {
    include: ["tests/**/*.manual.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
