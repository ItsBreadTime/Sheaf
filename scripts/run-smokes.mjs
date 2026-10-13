// Runs every browser smoke against the current dist/, one at a time: two in
// parallel contend for CPU during semantic indexing and time out spuriously.
// Stops at the first failure and exits with its code.
import { spawnSync } from "node:child_process";
import { requireBrowserPath } from "./lib/harness.mjs";

const SMOKES = [
  "action-popup",
  "settings-direct",
  "setup",
  "group-manager-ui",
  "tab-search-ui",
  "finder",
  "stash-ui",
  "auto-file",
  "popup",
];

requireBrowserPath();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
for (const smoke of SMOKES) {
  const startedAt = Date.now();
  process.stdout.write(`\n=== test:${smoke} ===\n`);
  const result = spawnSync(npm, ["run", `test:${smoke}`], { stdio: "inherit" });
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (result.status !== 0) {
    process.stdout.write(`\ntest:${smoke} failed after ${seconds} s.\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`test:${smoke} passed in ${seconds} s.\n`);
}
process.stdout.write(`\nAll ${SMOKES.length} smokes passed.\n`);
