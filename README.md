# Longhand

Type text, watch it written by a neural pen, and take the writing with you as
a living vector file. Every stroke is generated in your browser; there is no
generation backend.

**trylonghand.com** · work in progress

## How it works

A TypeScript port of the Graves (2013) handwriting RNN runs client-side
(three LSTMs, Gaussian window attention, mixture density head, ~3.6M
parameters). The engine emits a stroke IR (timed pen strokes) that a canvas
renderer plays back at authentic pen pace, and exporters turn into animated
SVG, GIF, video, and raw stroke JSON.

The [graves-handwriting-mlx](https://github.com/tmarkovski/graves-handwriting-mlx)
submodule is the reference implementation: source of the converted weights,
porting reference, and the oracle for golden tests. It never ships to users.

```
longhand/
├── graves-handwriting-mlx/     submodule: MLX reference + weights source
├── tools/                      Python (uv): weights export, golden vectors
├── packages/
│   ├── ink-core/               stroke IR types and geometry
│   └── ink-graves/             the TypeScript engine
├── apps/
│   └── web/                    the site (Vite + React)
└── docs/                       product brief and build plan
```

## Development

Requires Node 24+, pnpm, and [uv](https://docs.astral.sh/uv/) (asset
generation only; needs macOS for MLX).

```sh
git clone --recurse-submodules https://github.com/tmarkovski/longhand
pnpm install
pnpm gen:assets        # weights binary + golden test vectors (one time)
pnpm test
pnpm --filter @longhand/web dev
```

CI runs tests against MLX-generated goldens; pushes to `main` deploy to
GitHub Pages via `.github/workflows/deploy.yml`.

## License

Code license not yet chosen. The model weights descend from the
[sjvasquez/handwriting-synthesis](https://github.com/sjvasquez/handwriting-synthesis)
checkpoint (unlicensed) and are generated at build time, not distributed in
this repo. See `docs/plan.md` for the plan to train clean weights.
