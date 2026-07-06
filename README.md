# Longhand

Type text, watch it written by a neural pen, and take the writing with you as
a living vector file. Every stroke is generated on the client; there is no
generation backend.

**trylonghand.com** · work in progress

## How it works

Two handwriting engines run client-side. Both are inference-only ports of
existing work: the generation path, pinned to the original numerically,
without the training machinery.

- `ink-graves` ports the Graves (2013) handwriting RNN (three LSTMs,
  Gaussian window attention, mixture density head, ~3.6M parameters). The
  [graves-handwriting-mlx](https://github.com/tmarkovski/graves-handwriting-mlx)
  submodule is the reference implementation: the porting reference, the
  source of the exported weights, and the oracle for golden tests. It never
  ships to users.
- `ink-calligrapher` ports the [calligrapher.ai](https://www.calligrapher.ai)
  browser engine (Sean Vasquez). The snapshot in `vendor/calligrapher-ai/`
  is the parity oracle: the port reproduces its seeded output bit-for-bit
  from the same weights file.

The engines emit a stroke IR (timed pen strokes). `ink-render` is our own
rendering layer, not a port: Savitzky-Golay smoothing, baseline leveling,
speed-based pen widths, filled ribbon outlines, and animated SVG export. In
the web app a canvas renderer plays strokes back at authentic pen pace, and
exporters turn them into animated SVG, GIF, video, and raw stroke JSON.

`ink-swift` brings all of it to Apple platforms as a SwiftPM package. It is
a port of our own TypeScript packages rather than of the upstream repos, and
it is held to the same golden fixtures.

## Use it in your app

The repo is directly consumable from git — no registry, and the committed
weights come along for free. The site's guide
([trylonghand.com/#/build](https://trylonghand.com/#/build)) has full
examples; the studio's "use in your app" panel emits code for the exact
take on screen.

```sh
npm install github:tmarkovski/longhand   # or pnpm; TS source + weights
```

```ts
import { CalligrapherModel, parseCalligrapherWeights } from "longhand/ink-calligrapher";
import weightsUrl from "longhand/calligrapher.bin?url"; // Vite-style bundlers
```

```swift
// Package.swift (manifest lives at the repo root for exactly this)
.package(url: "https://github.com/tmarkovski/longhand", branch: "main")
// products: InkCore, InkGraves, InkCalligrapher, InkRender — the engine
// targets bundle their weights, so bundledGravesWeights() etc. just work.
```

Cross-package imports inside `packages/*/src` are relative (not
`@longhand/*`) so the single git-installed package resolves on its own;
a test guards that invariant.

```
longhand/
├── Package.swift               root SwiftPM manifest, so the repo is a git dependency
├── graves-handwriting-mlx/     submodule: MLX reference, golden-vector oracle
├── vendor/calligrapher-ai/     calligrapher.ai snapshot: porting reference, parity oracle
├── tools/                      Python (uv): weight export, golden vectors
├── packages/
│   ├── ink-core/               stroke IR types and geometry
│   ├── ink-graves/             Graves engine (TS port of the MLX reference)
│   ├── ink-calligrapher/       calligrapher.ai engine (TS port)
│   ├── ink-render/             pen and ribbon looks, animated SVG export
│   └── ink-swift/              Swift port of the four packages above + SwiftUI example
├── apps/
│   └── web/                    the site (Vite + React)
└── docs/                       product brief and build plan
```

## Development

Requires Node 24+, pnpm, and [uv](https://docs.astral.sh/uv/) for
golden-vector generation (MLX; pass `--cpu` to `tools/make_goldens.py` off
Apple silicon).

Model weights are committed package assets (`packages/ink-graves/assets`,
`packages/ink-calligrapher/assets`) shared by every consumer: the web app
syncs them into `public/model/` before `dev` and `build`, and the Swift
package reads the same files. The Graves asset (`graves-v2.bin`, ~3.6 MB)
stores int8 weights with a float32 scale per output column, dequantized at
load, plus a baked primed state per style, so styled writes start instantly
instead of teacher-forcing the style's strokes first. No weight generation
is needed to run the app.

```sh
git clone --recurse-submodules https://github.com/tmarkovski/longhand
pnpm install
pnpm gen:goldens       # golden test vectors, one time (MLX reference + Swift parity fixtures)
pnpm gen:weights       # f32 reference fixture for the Graves golden tests, one time
pnpm test              # TypeScript packages
pnpm --filter @longhand/web dev
```

For the Swift port, run `swift test -c release` at the repo root (after
`gen:goldens` and `gen:weights`). Release is the fast loop: the manifest
carries no unsafeFlags (remote consumers would reject them), so debug builds
run the engines at -Onone — fine for debugging, ~20x slower through the
parity suites, and the calligrapher perf gate compiles out. `pnpm
gen:weights` exports both Graves artifacts from the submodule: the committed
`graves-v2.bin`, and the gitignored float32 fixture the golden tests read
(MLX parity tolerances only hold for unquantized weights).

CI regenerates the golden vectors and the float32 fixture from the MLX
reference on every run, so the golden tests always check the ports against a
fresh oracle. Pushes to `main` deploy to GitHub Pages via
`.github/workflows/deploy.yml`.

## License

Code license not yet chosen. Neither set of model weights is ours to
license: the Graves weights descend from the
[sjvasquez/handwriting-synthesis](https://github.com/sjvasquez/handwriting-synthesis)
checkpoint (unlicensed), and the calligrapher weights are the file
calligrapher.ai serves to browsers (also unlicensed). Both are committed in
this repo as development assets. See `docs/plan.md` for the plan to train
clean weights.
