import { useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import CodeBlock from "./CodeBlock.js";
import { Segmented, ThemeToggle } from "./controls.js";
import type { EngineId } from "./protocol.js";
import {
  NPM_INSTALL,
  PLATFORMS,
  REPO_URL,
  SWIFT_DEPENDENCY,
  snippetFor,
  type Platform,
  type SnippetParams,
} from "./snippets.js";

/**
 * The developer guide: how to use the studio's engines in your own app,
 * straight from git. Platform-tabbed so more languages can slot in later;
 * the quickstart code comes from the same generators as the studio's
 * "use in your app" panel, so the two can never drift apart.
 */

/** The studio's boot take: what a first-time visitor just watched. */
const QUICKSTART: SnippetParams = {
  engine: "calligrapher",
  text: "a line of ink, thinking as it goes",
  bias: 0.6,
  legibility: "normal",
  style: 2,
  seed: 42,
  renderer: "pen",
  thickness: 1,
  speed: 1.5,
  ink: null,
  paper: null,
};

const SWIFT_PACKAGE_SNIPPET = [
  "// Package.swift",
  "dependencies: [",
  `    ${SWIFT_DEPENDENCY},`,
  "],",
  "targets: [",
  "    .target(",
  "        name: \"YourApp\",",
  "        dependencies: [",
  "            // Pick the engines you ship; each bundles its own weights.",
  "            .product(name: \"InkCalligrapher\", package: \"longhand\"), // 2.6 MB",
  "            .product(name: \"InkGraves\", package: \"longhand\"), // 15 MB, optional",
  "            .product(name: \"InkCore\", package: \"longhand\"),",
  "            .product(name: \"InkRender\", package: \"longhand\"),",
  "        ]",
  "    ),",
  "]",
].join("\n");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function ModelCard({
  name,
  size,
  traits,
  note,
}: {
  name: string;
  size: string;
  traits: string[];
  note: string;
}) {
  return (
    <div className="flex flex-1 flex-col gap-2 rounded-3xl bg-[oklch(0.93_0_0)] p-5 shadow-sm dark:bg-[oklch(0.23_0_0)]">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">{name}</h3>
        <span className="rounded-full bg-white/80 px-2.5 py-0.5 text-xs text-muted-foreground shadow-xs dark:bg-background/40">
          {size}
        </span>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
        {traits.map((trait) => (
          <li key={trait}>{trait}</li>
        ))}
      </ul>
      <p className="mt-auto pt-1 text-sm">{note}</p>
    </div>
  );
}

/** Parameter reference: one row per studio knob, mapped to the SDKs. */
const PARAMETERS: Array<{ knob: string; inCode: string; what: string }> = [
  {
    knob: "model",
    inCode: "CalligrapherModel / GravesModel",
    what: "which network writes; separate imports and separate weight files, so ship only what you use",
  },
  {
    knob: "style",
    inCode: "style",
    what: "which hand it writes in — calligrapher has styles 0–79 (the studio curates 1–9), longhand 0–12 plus freehand (null)",
  },
  {
    knob: "legibility",
    inCode: "bias",
    what: "sampling sharpness from ~0.2 (wild) to ~0.9 (neat); the studio's low/normal/high are 0.2 / 0.6 / 0.9",
  },
  {
    knob: "seed",
    inCode: "seed",
    what: "the take's identity: the same text, style, bias, and seed reproduce the same strokes on every platform",
  },
  {
    knob: "stroke",
    inCode: 'renderer: "pen" | "ribbon"',
    what: "the ink look — smoothed variable-width pen strokes, or speed-shaped filled ribbons",
  },
  {
    knob: "thickness",
    inCode: "pen.base / ribbonWidth",
    what: "ink weight; the code panel converts the studio multiplier into the option value for the chosen look",
  },
  {
    knob: "speed",
    inCode: "msPerStep",
    what: "animation pace: milliseconds per model timestep (8 is authentic pen speed; the studio default 1.5x is 5.33)",
  },
];

export default function BuildPage() {
  const [platform, setPlatform] = useState<Platform>("web");
  const [engine, setEngine] = useState<EngineId>("calligrapher");

  const quickstart = snippetFor(platform, { ...QUICKSTART, engine });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-7 sm:px-6 sm:py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <a
            href="#/"
            className="mb-2 flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" aria-hidden />
            studio
          </a>
          <h1 className="text-2xl font-semibold tracking-tight">Build with Longhand</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            the studio's handwriting engines as packages for your own app — installed straight
            from git, weights included, no servers and no keys
          </p>
        </div>
      </header>

      <Section title="pick a model">
        <p className="text-sm text-muted-foreground">
          Two engines, one stroke format. Each is a separate import with its own weight file, so
          an app ships only what it uses — on mobile, start with the calligrapher and add
          longhand only if its looser hand earns the download.
        </p>
        <div className="flex flex-col gap-4 sm:flex-row">
          <ModelCard
            name="calligrapher"
            size="2.6 MB"
            traits={[
              "9 curated styles, or a seed-picked random hand",
              "crisp, compact lines; tuned for the ribbon look",
              "lowercase-leaning latin, digits, punctuation",
            ]}
            note="The default. Small enough to load on a phone without anyone noticing."
          />
          <ModelCard
            name="longhand"
            size="15 MB"
            traits={[
              "13 primed styles plus an unprimed freehand mode",
              "looser, more human wander; tuned for the pen look",
              "the Graves (2013) handwriting RNN",
            ]}
            note="The heavyweight. Worth it on desktop or when freehand variety matters."
          />
        </div>
      </Section>

      <Section title="quickstart">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            aria-label="platform"
            options={PLATFORMS}
            value={platform}
            onChange={setPlatform}
          />
          <Segmented
            aria-label="model"
            options={[
              { value: "calligrapher", label: "calligrapher" },
              { value: "graves", label: "longhand" },
            ]}
            value={engine}
            onChange={setEngine}
          />
          <span className="text-xs text-muted-foreground">more languages on the way</span>
        </div>

        {platform === "web" ? (
          <>
            <p className="text-sm text-muted-foreground">
              Install the whole repo as one package, straight from GitHub (npm and pnpm verified;
              any manager that speaks the github: protocol works the same way):
            </p>
            <CodeBlock code={NPM_INSTALL} />
            <p className="text-sm text-muted-foreground">
              The packages ship as TypeScript source, so use a bundler that reads TS out of
              node_modules — Vite and anything else esbuild-based does. The weights ship inside
              the package and become a hashed asset via the <code className="text-xs">?url</code>{" "}
              import; nothing to host separately.
            </p>
            <CodeBlock code={quickstart} />
            <p className="text-sm text-muted-foreground">
              Generation is CPU-bound (a second or two per line) — run it in a Web Worker like
              the studio does so the page never janks. The animated SVG plays everywhere,
              including chat apps and READMEs.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Add the repo as a SwiftPM dependency (macOS 13+, iOS 16+). Each engine product
              bundles its weights as a package resource, so there is nothing to download or
              copy:
            </p>
            <CodeBlock code={SWIFT_PACKAGE_SNIPPET} />
            <CodeBlock code={quickstart} />
            <p className="text-sm text-muted-foreground">
              The engines run comfortably past 30x real pen speed on Apple silicon. For a full
              SwiftUI canvas that replays strokes at writing pace — the native equivalent of the
              studio — see{" "}
              <code className="text-xs">packages/ink-swift/Example</code> in the repo.
            </p>
          </>
        )}
      </Section>

      <Section title="the parameters">
        <p className="text-sm text-muted-foreground">
          Every knob in the studio maps one-to-one onto the SDKs. Dial in a take you like, open{" "}
          <a className="underline underline-offset-2 hover:text-foreground" href="#/">
            the studio
          </a>
          's <span className="font-medium">use in your app</span> panel, and copy code that
          reproduces it stroke for stroke — the TypeScript and Swift engines are parity-locked
          to the float, so a pinned seed is a portable take.
        </p>
        <div className="overflow-x-auto rounded-3xl bg-[oklch(0.93_0_0)] shadow-sm dark:bg-[oklch(0.23_0_0)]">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-5 pt-4 pb-2 font-medium">in the studio</th>
                <th className="px-3 pt-4 pb-2 font-medium">in code</th>
                <th className="px-5 pt-4 pb-2 font-medium">what it does</th>
              </tr>
            </thead>
            <tbody>
              {PARAMETERS.map((row) => (
                <tr key={row.knob} className="border-t border-foreground/10 align-top">
                  <td className="px-5 py-2.5 font-medium whitespace-nowrap">{row.knob}</td>
                  <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap">{row.inCode}</td>
                  <td className="px-5 py-2.5 text-muted-foreground">{row.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="just want the file?">
        <p className="text-sm text-muted-foreground">
          No code required: the{" "}
          <a className="underline underline-offset-2 hover:text-foreground" href="#/">
            studio
          </a>{" "}
          exports any take as still or animated SVG, PNG, GIF, MP4, or raw stroke JSON — same
          pipeline, same parameters, ready to drop into whatever you're making.
        </p>
      </Section>

      <footer className="flex items-center gap-1 text-xs text-muted-foreground/80">
        <span>
          <a className="underline underline-offset-2 hover:text-foreground" href={REPO_URL}>
            source on GitHub
          </a>{" "}
          · the model weights descend from research checkpoints (unlicensed); a clean training
          run is planned · <span className="italic">work in progress</span>
        </span>
        <ThemeToggle />
      </footer>
    </main>
  );
}
