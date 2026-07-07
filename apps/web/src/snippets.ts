/**
 * Code-snippet generators for the "use in your app" panel and the build
 * page: given the studio's current parameters, emit ready-to-paste code
 * for each SDK that reproduces the exact same take (the engines are
 * parity-locked across TypeScript and Swift, so the same seed writes the
 * same strokes everywhere).
 *
 * The emitted pipeline mirrors export.ts's animated-SVG export — polish,
 * ink-proportional scale, animated SVG — so what users copy matches what
 * the export button produces.
 */

import type { EngineId, RendererKind } from "./protocol.js";

/** How consumers reference the repo; single source for panel + docs. */
export const REPO_URL = "https://github.com/tmarkovski/longhand";
export const NPM_PACKAGE = "longhand";
export const NPM_INSTALL = `npm install ${REPO_URL.replace("https://github.com/", "github:")}`;
export const SWIFT_DEPENDENCY = `.package(url: "${REPO_URL}", branch: "main")`;
/** JitPack group: the GitHub URL as Maven coordinates. */
export const KOTLIN_GROUP = "com.github.tmarkovski.longhand";

export type Platform = "web" | "swift" | "kotlin";

export const PLATFORMS: ReadonlyArray<{ value: Platform; label: string }> = [
  { value: "web", label: "web · TypeScript" },
  { value: "swift", label: "Swift" },
  { value: "kotlin", label: "Android · Kotlin" },
];

export interface SnippetParams {
  engine: EngineId;
  text: string;
  /** Numeric sampling bias plus the UI label it came from. */
  bias: number;
  legibility: string;
  style: number | null;
  seed: number;
  renderer: RendererKind;
  /** UI thickness multiplier (1 = as tuned). */
  thickness: number;
  /** UI speed multiplier (1 = authentic pen pace). */
  speed: number;
  /** Resolved ink color, or null for "no color" (inherit). */
  ink: string | null;
  /** Paper color, or null for transparent. */
  paper: string | null;
}

/** Mirrors App.tsx: ink weight per engine + stroke look. */
const INK_WEIGHT: Record<EngineId, { pen: number; ribbon: number }> = {
  graves: { pen: 1, ribbon: 1 },
  calligrapher: { pen: 1, ribbon: 2 },
};

/** Mirrors the worker's engine descriptors. */
const RIBBON_FACTOR: Record<EngineId, number> = { graves: 3, calligrapher: 1 };

/** Mirrors App.tsx's PEN_WIDTH_PER_SCALE and DT_MS. */
const PEN_WIDTH_PER_SCALE = 2.2 / 1.6;
const DT_MS = 8;

const round = (value: number, digits = 3) => String(Number(value.toFixed(digits)));

/** The studio look, resolved to the renderer options the SDKs take. */
export function renderNumbers(params: SnippetParams) {
  return {
    penBasePerScale: round(
      PEN_WIDTH_PER_SCALE * params.thickness * INK_WEIGHT[params.engine].pen,
    ),
    ribbonWidth: round(
      0.75 * RIBBON_FACTOR[params.engine] * params.thickness * INK_WEIGHT[params.engine].ribbon,
    ),
    msPerStep: round(DT_MS / params.speed, 2),
  };
}

const ENGINE_MODULE: Record<EngineId, string> = {
  graves: `${NPM_PACKAGE}/ink-graves`,
  calligrapher: `${NPM_PACKAGE}/ink-calligrapher`,
};

// Stable subpaths (the version lives in the underlying filename), matching
// the root package.json exports map.
const WEIGHTS_SUBPATH: Record<EngineId, string> = {
  graves: `${NPM_PACKAGE}/graves.bin`,
  calligrapher: `${NPM_PACKAGE}/calligrapher.bin`,
};

const WEIGHTS_SIZE: Record<EngineId, string> = { graves: "3.6 MB", calligrapher: "2.6 MB" };

/** Swift string literals share JSON's escapes for quote/backslash/controls. */
const quote = (text: string) => JSON.stringify(text);

/** Kotlin shares JSON's escapes too but adds string templates: escape `$`. */
const kquote = (text: string) => JSON.stringify(text).replace(/\$/g, "\\$");

/** Kotlin has no implicit widening: Double parameters need Double literals. */
const kdouble = (value: string) => (value.includes(".") ? value : `${value}.0`);

function styleLinesTs(params: SnippetParams): string[] {
  if (params.style !== null) return [`  style: ${params.style},`];
  return params.engine === "graves"
    ? ["  style: null, // freehand (no style priming)"]
    : ["  style: null, // a seed-picked style, like the studio's random"];
}

export function tsSnippet(params: SnippetParams): string {
  const { penBasePerScale, ribbonWidth, msPerStep } = renderNumbers(params);
  const ribbon = params.renderer === "ribbon";
  const model =
    params.engine === "graves"
      ? { className: "GravesModel", parse: "parseModelAssets" }
      : { className: "CalligrapherModel", parse: "parseCalligrapherWeights" };

  const lines = [
    `// ${NPM_INSTALL}`,
    `import { lineBounds, offsetsToLine } from "${NPM_PACKAGE}/ink-core";`,
    `import { ${model.className}, ${model.parse} } from "${ENGINE_MODULE[params.engine]}";`,
    `import { ${ribbon ? "alignLine" : "polishLine"}, lineToAnimatedSvg } from "${NPM_PACKAGE}/ink-render";`,
    `import weightsUrl from "${WEIGHTS_SUBPATH[params.engine]}?url";`,
    "",
    `// The weights ship inside the package (${WEIGHTS_SIZE[params.engine]}); load them once.`,
    `const buffer = await fetch(weightsUrl).then((r) => r.arrayBuffer());`,
    `const model = new ${model.className}(${model.parse}(buffer));`,
    "",
    "// These exact settings replay the studio take, stroke for stroke.",
    `const offsets = model.write(${quote(params.text)}, {`,
    `  bias: ${params.bias}, // legibility: ${params.legibility}`,
    ...styleLinesTs(params),
    `  seed: ${params.seed},`,
    "});",
    "",
    ribbon
      ? "// Ribbon look: level the baseline, keep the speed-shaped widths."
      : "// Pen look: smooth the jitter, level the baseline.",
    `const line = ${ribbon ? "alignLine" : "polishLine"}(offsetsToLine(offsets));`,
    "const bounds = lineBounds(line);",
    "const scale = 200 / Math.max(bounds.maxY - bounds.minY, 1);",
    "",
    "// Or lineToSvg(line, { ...same options }) for a still image.",
    "const svg = lineToAnimatedSvg(line, {",
    `  renderer: "${params.renderer}",`,
    "  scale,",
    "  padding: 40,",
    ...(params.ink ? [`  ink: ${quote(params.ink)},`] : ["  // ink omitted: inherits currentColor"]),
    ...(params.paper ? [`  background: ${quote(params.paper)},`] : []),
    ribbon
      ? `  ribbonWidth: ${ribbonWidth}, // thickness ${round(params.thickness, 2)}x`
      : `  pen: { base: ${penBasePerScale} * scale }, // thickness ${round(params.thickness, 2)}x`,
    `  msPerStep: ${msPerStep}, // speed ${round(params.speed, 2)}x`,
    "});",
  ];
  return lines.join("\n");
}

export function swiftSnippet(params: SnippetParams): string {
  const { penBasePerScale, ribbonWidth, msPerStep } = renderNumbers(params);
  const ribbon = params.renderer === "ribbon";
  const model =
    params.engine === "graves"
      ? { className: "GravesModel", target: "InkGraves", weights: "bundledGravesWeights" }
      : {
          className: "CalligrapherModel",
          target: "InkCalligrapher",
          weights: "bundledCalligrapherWeights",
        };

  const styleLine =
    params.style !== null
      ? [`    style: ${params.style},`]
      : params.engine === "graves"
        ? ["    // style omitted: freehand (no style priming)"]
        : ["    // style omitted: a seed-picked style, like the studio's random"];

  const lines = [
    `// Package.swift: ${SWIFT_DEPENDENCY}`,
    `// Target products: "InkCore", "${model.target}", "InkRender"`,
    `import ${model.target}`,
    "import InkCore",
    "import InkRender",
    "",
    `// The weights ship inside the package (${WEIGHTS_SIZE[params.engine]}); load once.`,
    `let model = try ${model.className}(assets: ${
      params.engine === "graves" ? "parseModelAssets" : "parseCalligrapherWeights"
    }(${model.weights}()))`,
    "",
    "// These exact settings replay the studio take, stroke for stroke.",
    "let offsets = try model.write(",
    `    ${quote(params.text)},`,
    `    bias: ${params.bias}, // legibility: ${params.legibility}`,
    ...styleLine,
    `    seed: ${params.seed}`,
    ")",
    "",
    ribbon
      ? "// Ribbon look: level the baseline, keep the speed-shaped widths."
      : "// Pen look: smooth the jitter, level the baseline.",
    `let line = ${ribbon ? "alignLine" : "polishLine"}(offsetsToLine(offsets))`,
    "let bounds = lineBounds(line)!",
    "let scale = 200 / max(bounds.height, 1)",
    "",
    "// Or lineToSvg(line, options: .init(...)) for a still image.",
    "let svg = lineToAnimatedSvg(line, options: AnimatedSvgOptions(",
    "    line: LineSvgOptions(",
    `        renderer: .${params.renderer},`,
    "        scale: scale,",
    "        padding: 40,",
    ...(params.ink ? [`        ink: ${quote(params.ink)},`] : []),
    ...(params.paper ? [`        background: ${quote(params.paper)},`] : []),
    ribbon
      ? `        ribbonWidth: ${ribbonWidth} // thickness ${round(params.thickness, 2)}x`
      : `        pen: PenWidthOptions(base: ${penBasePerScale} * scale) // thickness ${round(params.thickness, 2)}x`,
    "    ),",
    `    msPerStep: ${msPerStep} // speed ${round(params.speed, 2)}x`,
    "))",
  ];
  return lines.join("\n");
}

export function kotlinSnippet(params: SnippetParams): string {
  const { penBasePerScale, ribbonWidth, msPerStep } = renderNumbers(params);
  const ribbon = params.renderer === "ribbon";
  const model =
    params.engine === "graves"
      ? {
          className: "GravesModel",
          module: "graves",
          parse: "parseModelAssets",
          weights: "bundledGravesWeights",
        }
      : {
          className: "CalligrapherModel",
          module: "calligrapher",
          parse: "parseCalligrapherWeights",
          weights: "bundledCalligrapherWeights",
        };

  const styleLine =
    params.style !== null
      ? [`    style = ${params.style},`]
      : params.engine === "graves"
        ? ["    // style omitted: freehand (no style priming)"]
        : ["    // style omitted: a seed-picked style, like the studio's random"];

  const lines = [
    `// build.gradle.kts: repositories { maven("https://jitpack.io") } and`,
    `// implementation("${KOTLIN_GROUP}:ink-${model.module}:main-SNAPSHOT") // + :ink-render`,
    `import com.trylonghand.ink.${model.module}.${model.className}`,
    `import com.trylonghand.ink.${model.module}.${model.parse}`,
    `import com.trylonghand.ink.${model.module}.${model.weights}`,
    "import com.trylonghand.ink.core.lineBounds",
    "import com.trylonghand.ink.core.offsetsToLine",
    "import com.trylonghand.ink.render.*",
    "",
    `// The weights ship inside the module's JAR (${WEIGHTS_SIZE[params.engine]}); load once.`,
    `val model = ${model.className}(${model.parse}(${model.weights}()))`,
    "",
    "// These exact settings replay the studio take, stroke for stroke.",
    "val offsets = model.write(",
    `    ${kquote(params.text)},`,
    `    bias = ${kdouble(String(params.bias))}, // legibility: ${params.legibility}`,
    ...styleLine,
    `    seed = ${params.seed}u,`,
    ")",
    "",
    ribbon
      ? "// Ribbon look: level the baseline, keep the speed-shaped widths."
      : "// Pen look: smooth the jitter, level the baseline.",
    `val line = ${ribbon ? "alignLine" : "polishLine"}(offsetsToLine(offsets))`,
    "val bounds = lineBounds(line)!!",
    "val scale = 200 / maxOf(bounds.height, 1.0)",
    "",
    "// Or lineToSvg(line, LineSvgOptions(...)) for a still image.",
    "val svg = lineToAnimatedSvg(line, AnimatedSvgOptions(",
    "    line = LineSvgOptions(",
    `        renderer = InkRenderer.${params.renderer},`,
    "        scale = scale,",
    "        padding = 40.0,",
    ...(params.ink ? [`        ink = ${kquote(params.ink)},`] : []),
    ...(params.paper ? [`        background = ${kquote(params.paper)},`] : []),
    ribbon
      ? `        ribbonWidth = ${kdouble(ribbonWidth)}, // thickness ${round(params.thickness, 2)}x`
      : `        pen = PenWidthOptions(base = ${kdouble(penBasePerScale)} * scale), // thickness ${round(params.thickness, 2)}x`,
    "    ),",
    `    msPerStep = ${kdouble(msPerStep)}, // speed ${round(params.speed, 2)}x`,
    "))",
  ];
  return lines.join("\n");
}

export function snippetFor(platform: Platform, params: SnippetParams): string {
  if (platform === "web") return tsSnippet(params);
  if (platform === "swift") return swiftSnippet(params);
  return kotlinSnippet(params);
}
