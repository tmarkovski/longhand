# Build Plan

*v1, 2026-07-03. Companion to [product-brief.md](product-brief.md). The brief says what and why; this says how.*

## Summary

A client-side web app: type text, watch a neural pen write it live, export the result as an animated SVG, GIF, video, or raw stroke data. The neural engine is a TypeScript port of the Graves handwriting model running fully in the browser. No backend in v1. The `graves-handwriting-mlx` submodule is our reference implementation and weights source, never a runtime dependency.

## Tech decisions

| # | Decision | Choice | Status |
|---|---|---|---|
| 1 | Language / repo shape | TypeScript monorepo (pnpm workspaces); Python (uv) only in `tools/` | decided |
| 2 | Neural inference | Hand-rolled TS engine in the browser; ONNX Runtime Web as fallback | decided, gate in week 1 |
| 3 | Live rendering | Canvas 2D; worker streams strokes, pen replays the polished line (smooth + align + ink widths) | decided, revised 2026-07-03 |
| 4 | UI framework | React + Vite + Tailwind; core packages framework-free | decided |
| 5 | Backend | None. Static hosting (GitHub Pages, custom domain trylonghand.com); share links carry full state in the URL | decided |
| 6 | Testing | Golden numeric tests against the MLX reference; Playwright visual regression | decided |

### 2. Why a hand-rolled TS engine

The model is small: three stacked 400-unit LSTMs, a Gaussian attention window over the text, and a 20-component mixture density head. A few million parameters, a few MB as f16. calligrapher.ai already proves this exact model runs fine as plain JavaScript in the browser, and the MLX submodule gives us a clean, readable reference implementation to port from (it is a few hundred lines).

What hand-rolling buys us over ONNX Runtime Web:

- No 1 MB+ WASM runtime in the bundle; total payload is weights plus a small JS core.
- Full control of the sampling loop: bias, style priming, deterministic seeds, and a per-step callback so the pen draws while the model thinks.
- No awkward threading of LSTM state through session inputs/outputs on every step.

The risk is correctness, which golden tests remove: `tools/` uses the MLX submodule to record per-step attention and mixture-density outputs for fixed inputs, and the TS engine must match them within floating-point tolerance.

**Week 1 gate:** the TS engine must sustain at least ~125 steps/sec single-threaded (playback speed is 8 ms per step, so generation stays ahead of the pen). If it cannot, fall back to ONNX Runtime Web (X-rayLaser's toolkit already has a working ONNX export and browser demo).

### 5. Why no backend

Generation is deterministic given (text, style, bias, seed, params). That means a share link does not need a database: compress the full state into the URL (lz-string) and any visitor reproduces the exact same writing. Exports are generated client-side too. The only future reasons for a server are an API product and server-side video rendering, both explicitly Phase 3.

## Architecture

```
longhand/
├── graves-handwriting-mlx/     submodule: reference impl + source of weights
├── tools/                      Python (uv): weights export, golden test vectors
├── packages/
│   ├── ink-core/               stroke IR types, geometry, timing, URL state codec
│   ├── ink-graves/             TS inference: LSTM + attention + MDN, styles, sampling
│   ├── ink-render/             canvas playback, streaming, pacing model
│   └── ink-export/             animated SVG, static SVG, strokes JSON, PNG, GIF, video
└── apps/
    └── web/                    the React app
```

### Stroke IR (the one abstraction everything shares)

Every engine emits it, every renderer and exporter consumes it. Points are fixed-interval model timesteps, which is what makes the animation pacing feel human (dense points = slow pen, sparse = fast).

```jsonc
{
  "version": 1,
  "dtMs": 8,                       // one model timestep
  "lines": [
    { "strokes": [ { "points": [[x, y], ...] } ] }   // stroke boundary = pen lift
  ],
  "meta": { "text": "...", "style": 9, "bias": 0.75, "seed": 42 }
}
```

This is also the raw-data export format, documented publicly for the plotter community.

## User experience

One screen, no onboarding. The flow:

1. **Type.** Big text input, prefilled with a playful example so the first paint is already writing itself.
2. **Watch.** The pen writes on canvas as the model samples (streaming, not generate-then-play). This is the signature moment: the ink appears while the model thinks, with authentic accelerations and pauses at pen lifts.
3. **Tweak.** Controls panel: style gallery, legibility (bias), speed, stroke width, ink color, paper (plain, lined, grid, warm parchment), shuffle (new seed), replay. Every change regenerates or re-times live.
4. **Export or share.** Export dialog with format cards; share button copies a URL that reproduces everything.

Details that matter:

- **Style gallery**: animated thumbnails, each style writing a short sample on loop. One gallery; when the font engine lands in Phase 2, its styles appear in the same picker.
- **Input validation inline**: the model's alphabet has gaps (no uppercase Q, X, Z, limited punctuation). Unsupported characters get highlighted in the input with a suggested substitution, never a silent failure. 75 chars per line, soft-wrapped into multi-line.
- **Multi-line playback**: toggle between "all lines write at once" (great for posters) and "line by line" (natural reading order).
- **Deterministic by default**: the seed is visible in advanced settings; shuffle changes it. Same inputs always reproduce the same writing, which makes share links and embeds trustworthy.
- Desktop-first creation, mobile-friendly playback and light editing.

## Features

**v1 (MVP)**
- 13 neural handwriting styles with animated gallery
- Streaming live writing on canvas
- Controls: bias, speed, width, ink color, paper, seed/shuffle, multi-line
- Exports: animated SVG, static SVG, PNG, strokes JSON, GIF, MP4/WebM
- Share links (URL state, no accounts)
- Character validation UX

**v1.5**
- Lottie export (trim paths map 1:1 to our dash technique)
- Embeddable renderer: npm package + copy-paste snippet
- Paper textures, calligraphic nib profiles (perfect-freehand outlines)

**v2**
- Font-tracing engine (tegaki) behind the same stroke IR: script/calligraphy fonts, multilingual scripts the neural engine can't do
- "Write in my handwriting": tablet/phone capture, style priming
- HTTP API for developers
- DiffInk evaluation for one-shot style cloning (go/no-go after English retrain assessment)

## Export types

| Format | How | Notes |
|---|---|---|
| **Animated SVG** | CSS keyframes dash-reveal with per-timestep pacing | The hero export. Self-contained, loops, small (10-500 KB). Technique already built and validated in Phase 0. |
| Static SVG | Centerline polylines; optional variable-width outline (perfect-freehand) | Plotter-friendly centerlines; outlined version for print. |
| Strokes JSON | The stroke IR verbatim | Documented schema; the plotter/maker community's ask. |
| PNG | Canvas snapshot at 1x/2x/4x | Transparent background option. |
| GIF | OffscreenCanvas frames + gifenc | Size/fps presets; the social-media workhorse. |
| MP4 / WebM | WebCodecs + mp4-muxer/webm-muxer, client-side | Chromium first; other browsers fall back to GIF. Transparent WebM for video overlays. |
| Lottie | Trim-path animation (v1.5) | After Effects / mobile-app pipelines. |

## Build order

**Phase 1: MVP, ~4 weeks**

- **Week 1: foundations.** Monorepo scaffold; `tools/export_weights.py` (MLX safetensors → compact f16 binary); golden test vectors from the submodule; TS engine spike. *Gate: engine matches golden outputs and sustains 125+ steps/sec, else switch to ONNX path.*
- **Week 2: engine + renderer.** Complete `ink-graves` (13 styles, priming, bias, seed, streaming callback); `ink-render` canvas playback with the pacing model; bare-bones test app.
- **Week 3: the product.** Full UI (gallery, controls, validation, multi-line); animated SVG + static SVG + PNG + JSON exports; share URLs.
- **Week 4: ship.** GIF and video export; animated style thumbnails; polish and a11y pass; deploy to GitHub Pages (trylonghand.com); README and landing copy.

**Phase 2 (~3 weeks):** tegaki font engine + font gallery; Lottie export; embeddable npm package; paper/nib polish.

**Phase 3:** own-handwriting capture; own trained weights (licensing exit); API; DiffInk evaluation.

## Risks (carried from the brief)

1. **Weights licensing** is still the big one: the converted weights descend from the unlicensed sjvasquez checkpoint and research-only IAM-OnDB. Fine for a free tool while we build; must be resolved (own training run) before charging money. License request to the MLX port author is filed (breitburg/graves-handwriting-mlx#1) for the code side.
2. **Safari video export** lacks reliable WebCodecs encoding; GIF fallback covers it, revisit later.
3. **JS engine performance** on low-end devices; the week-1 gate and ONNX fallback cover it.

## Decisions log

| Date | Decision | Call |
|---|---|---|
| 2026-07-03 | Repo: brief + plan + MLX submodule (fork) | done |
| 2026-07-03 | Primary audience | Creators first; developers in Phase 2 (embed package) |
| 2026-07-03 | v1 backend | Client-side only. Revisit at Phase 3 or at the first of: API product, og-image link previews, saved galleries, long-text share links |
| 2026-07-03 | Business model | Free for now, no paywall plumbing in the MVP. Pro tier only after we own commercially clean weights |
| 2026-07-03 | Name | "Cali" stays as working title; brand exploration running separately. Final call before the week-4 deploy |
| 2026-07-03 | Week-1 engine gate | **Passed.** TS engine matches MLX goldens (240 forced steps, 2 cases, atol 2e-3) and runs 332 steps/sec in Node, 2.7x the 125 requirement. ONNX fallback not needed |
| 2026-07-03 | Name | **Longhand** (supersedes "Cali stays" above). trylonghand.com registered. Collision sweep done: no USPTO word mark indexed, Product Hunt/Google Play clear; two small coexisting products (Botto Studio iOS app with stroke-replay notes, worth watching; longhand.dev pre-launch LaTeX editor). Before charging: manual USPTO confirm + intent-to-use filing (classes 9/42). "Ductus" reserved as possible stroke-IR format name |
| 2026-07-03 | Hosting | GitHub Pages via Actions (free for the public repo), custom domain trylonghand.com. npm scope @longhand. Revisit hosting only if Pages limits bite |
| 2026-07-03 | Share domain | cursive.cool registered (the "cursive is cool" domain hack). Brand stays Longhand; cursive.cool earmarked for share links (`cursive.cool/s/<id>`) and campaign landers |
| 2026-07-03 | Legibility cap | Slider capped at bias 1.0. Above ~1.0 the sampler goes near-deterministic and the hidden state falls into a cramped-scribble attractor (stochastic, seed- and length-dependent; reproduced identically in the MLX reference, so a weights property, not a port bug). calligrapher.ai runs clean at bias 2.5 on an unreleased checkpoint, confirming better weights raise the ceiling; ours moves with the Phase 3 training run |
| 2026-07-03 | ink-render v1 | New `@longhand/ink-render`: Savitzky-Golay smoothing + least-squares baseline alignment (ports of the reference `_denoise`/`_align`, golden-tested vs scipy/numpy) + speed-based pen widths. Canvas flow changed from draw-while-sampling to generate-then-replay, since alignment needs the whole line; a "thinking…" phase (~2-3 s) precedes the pen. Matches the calligrapher.ai polish recipe (Bézier ribbons there, per-segment widths here) |
