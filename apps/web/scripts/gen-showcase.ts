/**
 * Prerenders the use-case gallery (src/showcase.ts) to animated SVGs in
 * src/showcase/, one per vignette, through the same pipeline as the
 * studio's animated-SVG export: polish (or align, for ribbons), scale to
 * a 200-unit ink height, serialize with SMIL reveal timing. The output
 * is committed so builds and CI never need to run the models, and the
 * gallery page inlines the files (?raw) so a take without a fixed ink
 * can inherit `currentColor` from the page theme.
 *
 * Run from the repo root: `pnpm gen:showcase`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lineBounds, offsetsToLine } from "@longhand/ink-core";
import { CalligrapherModel, parseCalligrapherWeights } from "@longhand/ink-calligrapher";
import { GravesModel, parseModelAssets } from "@longhand/ink-graves";
import { alignLine, lineToAnimatedSvg, polishLine } from "@longhand/ink-render";
import { SHOWCASE } from "../src/showcase.js";
import { renderNumbers } from "../src/snippets.js";

// Mirrors export.ts: ink height in layout units, whitespace around it.
const INK_HEIGHT = 200;
const PADDING = 40;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = path.resolve(here, "../src/showcase");

async function weights(relative: string): Promise<ArrayBuffer> {
  const buffer = await readFile(path.join(repoRoot, relative));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

const engines = {
  graves: new GravesModel(
    parseModelAssets(await weights("packages/ink-graves/assets/graves-v2.bin")),
  ),
  calligrapher: new CalligrapherModel(
    parseCalligrapherWeights(await weights("packages/ink-calligrapher/assets/calligrapher-v1.bin")),
  ),
};

await mkdir(outDir, { recursive: true });

for (const item of SHOWCASE) {
  const { take } = item;
  const model = engines[take.engine];
  const unsupported = [...new Set([...take.text].filter((c) => !model.supports(c)))];
  if (unsupported.length > 0) {
    throw new Error(
      `${item.id}: the ${take.engine} model can't write ${JSON.stringify(unsupported.join(""))}`,
    );
  }

  const offsets = model.write(take.text, {
    bias: take.bias,
    style: take.style,
    seed: take.seed,
  });
  const ribbon = take.renderer === "ribbon";
  const line = ribbon ? alignLine(offsetsToLine(offsets)) : polishLine(offsetsToLine(offsets));
  const bounds = lineBounds(line);
  const scale = INK_HEIGHT / Math.max(bounds.maxY - bounds.minY, 1);
  const { penBasePerScale, ribbonWidth, msPerStep } = renderNumbers(take);

  const svg = lineToAnimatedSvg(line, {
    renderer: take.renderer,
    scale,
    padding: PADDING,
    // A fixed ink is baked in; null stays `currentColor` for theme-following
    // ink. Never a background: the scene chrome brings the paper.
    ...(take.ink ? { ink: take.ink } : {}),
    pen: { base: Number(penBasePerScale) * scale },
    ribbonWidth: Number(ribbonWidth),
    msPerStep: Number(msPerStep),
  });

  // The gallery inlines several of these into one document, where the
  // ribbon reveal masks' ids (reveal0, reveal1, …) would collide across
  // vignettes and hijack each other's strokes; namespace them by slug.
  const inlineSafe = svg
    .replaceAll('id="reveal', `id="${item.id}-reveal`)
    .replaceAll("url(#reveal", `url(#${item.id}-reveal`);

  const file = path.join(outDir, `${item.id}.svg`);
  await writeFile(file, inlineSafe);
  console.log(
    `${item.id}.svg  ${(svg.length / 1024).toFixed(0)} KB  ` +
      `(${offsets.length} steps, seed ${take.seed})`,
  );
}
