// Copies non-TS UI assets (HTML/CSS) from src/ui → dist/ui.
// tsc compiles src/ui/*.ts → dist/ui/*.js itself; it ignores everything else.
// run automatically by `npm run build` (tsc && node scripts/copy-ui.mjs).
import { cpSync, mkdirSync, existsSync } from "node:fs";

const assets = ["index.html", "styles.css"];
mkdirSync("dist/ui", { recursive: true });
for (const file of assets) {
  const src = `src/ui/${file}`;
  if (!existsSync(src)) {
    console.error(`copy-ui: missing ${src}`);
    process.exit(1);
  }
  cpSync(src, `dist/ui/${file}`);
}
