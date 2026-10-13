// Fails when a page's startup payload in dist/ outgrows its budget: the entry
// script, every chunk it imports statically (transitively), and its stylesheets.
// Lazy chunks (dynamic import()) are not counted; they load on first use.
// action-popup-size-smoke checks layout only, so this is the size guard.
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { projectRoot } from "./lib/harness.mjs";

const dist = resolve(projectRoot, "dist");
const KB = 1024;
// About 10% over the sizes when the budgets were set (popup 819 kB, finder 57 kB,
// worker 553 kB). Raise one deliberately, in the same change that needs it.
const BUDGETS = [
  { name: "popup", entry: "action.html", maxBytes: 900 * KB },
  { name: "finder", entry: "finder.html", maxBytes: 64 * KB },
  { name: "service worker", entry: "service-worker.js", maxBytes: 610 * KB },
];

async function staticGraph(file, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  if (!file.endsWith(".js")) return;
  const source = await readFile(file, "utf8");
  // Static imports only: `import ... from "x"` and side-effect `import "x"`.
  // `import("x")` is lazy and deliberately skipped.
  for (const match of source.matchAll(/\bimport\s*(?:[\w${},\s*]+\s*from\s*)?["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) await staticGraph(resolve(dirname(file), specifier), seen);
  }
}

async function pageFiles(entry) {
  const entryPath = resolve(dist, entry);
  const seen = new Set();
  if (entry.endsWith(".html")) {
    const html = await readFile(entryPath, "utf8");
    seen.add(entryPath);
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)) {
      const target = resolve(dist, match[1]);
      if (/\.(?:js|css)$/.test(target)) await staticGraph(target, seen);
    }
  } else {
    await staticGraph(entryPath, seen);
  }
  return [...seen];
}

let failed = false;
for (const budget of BUDGETS) {
  const files = await pageFiles(budget.entry);
  const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const line = `${budget.name}: ${(total / KB).toFixed(1)} kB of ${(budget.maxBytes / KB).toFixed(0)} kB (${files.length} files)`;
  if (total > budget.maxBytes) {
    failed = true;
    console.error(`Over budget — ${line}`);
  } else {
    console.log(line);
  }
}
if (failed) process.exit(1);
