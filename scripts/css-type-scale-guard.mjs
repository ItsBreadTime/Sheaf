// Fails when a stylesheet sets type outside the committed scale. The caption
// floor rule and "no raw rem sizes outside the scale" are only real if something
// enforces them; this runs as part of `npm run check`.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = [
  resolve(root, "src/ui/action/styles.css"),
  resolve(root, "src/ui/finder/finder.css"),
];

// The scale, plus the group manager's alias layer (which must itself point at the scale).
const ALLOWED = /^var\(--(text-(xs|sm|md|lg|xl)|gm-(caption|meta|body|subheading|heading))\)$/;
// The popup's 17px root is what every rem token scales from.
const ALLOWED_LITERAL = new Set(["17px"]);
const ALIAS = /--gm-(caption|meta|body|subheading|heading):\s*([^;]+);/g;

const violations = [];
for (const file of files) {
  const css = await readFile(file, "utf8");
  const rel = file.slice(root.length + 1);

  for (const match of css.matchAll(/font-size:\s*([^;{}]+);/g)) {
    const value = match[1].trim();
    if (!ALLOWED.test(value) && !ALLOWED_LITERAL.has(value)) violations.push(`${rel}: font-size: ${value}`);
  }
  for (const match of css.matchAll(/font:\s*([^;{}]+);/g)) {
    const value = match[1].trim();
    if (value === "inherit") continue;
    if (/[0-9]/.test(value) && !value.startsWith("var(--")) {
      violations.push(`${rel}: font: ${value}`);
    }
  }
  for (const match of css.matchAll(ALIAS)) {
    const value = match[2].trim();
    if (!value.startsWith("var(--text-")) {
      violations.push(`${rel}: --gm-${match[1]}: ${value}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Type-scale violations (${violations.length}):`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("Type scale: every font-size uses the committed tokens.");
