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

```
longhand/
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
package reads the same files. No weight generation is needed to run
anything.

```sh
git clone --recurse-submodules https://github.com/tmarkovski/longhand
pnpm install
pnpm gen:goldens       # golden test vectors, one time (MLX reference + Swift parity fixtures)
pnpm test              # TypeScript packages
pnpm --filter @longhand/web dev
```

For the Swift port, run `swift test` in `packages/ink-swift` (after
`gen:goldens`). `pnpm gen:weights` regenerates the committed Graves weights
from the submodule; it is only needed when the reference weights change.

CI regenerates the golden vectors from the MLX reference on every run, so
the golden tests double as a drift check on the committed weights. Pushes to
`main` deploy to GitHub Pages via `.github/workflows/deploy.yml`.

## License

Code license not yet chosen. Neither set of model weights is ours to
license: the Graves weights descend from the
[sjvasquez/handwriting-synthesis](https://github.com/sjvasquez/handwriting-synthesis)
checkpoint (unlicensed), and the calligrapher weights are the file
calligrapher.ai serves to browsers (also unlicensed). Both are committed in
this repo as development assets. See `docs/plan.md` for the plan to train
clean weights.
