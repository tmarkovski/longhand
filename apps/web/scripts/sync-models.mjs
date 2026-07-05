/**
 * Copies the engine packages' committed model weights into public/model/
 * so the site can serve them. The packages own the canonical binaries
 * (packages/ink-graves/assets, packages/ink-calligrapher/assets) and the
 * Swift port reads the same files; this directory is just the web
 * deployment view of them, so it stays gitignored.
 *
 * Runs before `dev` and `build` (see package.json scripts).
 */
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const models = [
  ["../../../packages/ink-graves/assets/graves-v1.bin", "graves-v1.bin"],
  ["../../../packages/ink-calligrapher/assets/calligrapher-v1.bin", "calligrapher-v1.bin"],
];

const outDir = `${here}../public/model/`;
mkdirSync(outDir, { recursive: true });
for (const [source, name] of models) {
  const from = `${here}${source}`;
  copyFileSync(from, `${outDir}${name}`);
  console.log(`model: ${name} (${(statSync(from).size / 1e6).toFixed(1)} MB)`);
}
