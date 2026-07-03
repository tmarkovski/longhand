# Cali (working title): Product Brief

*Draft v2, 2026-07-03. For iteration. Items marked **[OPEN]** need a decision.*

## One-liner

Type text, watch it written by a human hand, and take the writing with you as a
living vector file, not a video.

## The gap

Every existing option fails on at least one axis:

| | Neural realism | Animated output | Stroke data access | Exports/API/SDK | Alive |
|---|---|---|---|---|---|
| calligrapher.ai | ✅ | in-app only | ❌ (static SVG dump) | ❌ | frozen for years |
| tegaki | ❌ (font tracing) | ✅ | ✅ | ✅ SDK, no API | very active |
| SignatureGen etc. | ✅ (repackaged) | ✅ | ❌ | ❌ | paywalling |
| handwriting.io | n/a | n/a | n/a | API | dead |

**Nobody pairs a neural stroke model with a modern product surface** (exports,
raw strokes, embeds, API). Demand evidence: a GPL tool exists solely to scrape
calligrapher.ai's strokes for pen plotters, and tegaki went 0 to 2.9k stars in
three months on the animation use case alone.

## Users & use cases

1. **Creators / marketers**: animated handwriting for social video, intros,
   invitations, e-cards. Want: styles, color/paper, GIF/WebM/Lottie export.
2. **Developers / product teams**: "handwritten" moments in UIs (AI chat
   reveals, onboarding, signatures). Want: embeddable renderer, deterministic
   seeds, API. (tegaki's traction validates this segment.)
3. **Plotter / maker community**: raw stroke sequences. Small but vocal;
   free tier goodwill, zero marginal cost.

**[OPEN] Primary segment for v1?** Draft assumption: creators first (visible
outputs, shareable, organic growth), developers second (SDK/API monetization).

## Product shape

A web app (and later an SDK/API) built around one core abstraction: the
**stroke IR**, timed and ordered pen strokes with width profiles. Two engines
emit it; one renderer/exporter consumes it.

```
[text + style + params]
   ├─ Engine A: neural freehand (Graves-class v1 → DiffInk v2)
   └─ Engine B: font tracing (tegaki, MIT)
            ↓
   stroke IR: [{points[], timing[], width[], penlift}]
            ↓
   renderer (live canvas/SVG) + exporters
```

### Features (v1)

- **Style gallery**: ~13 neural handwriting styles (priming samples) plus
  curated script/calligraphy fonts via tegaki. One picker, two engines; the
  user doesn't care which engine serves a style.
- **Controls**: legibility (bias), speed, stroke width, ink color, paper,
  slant/stretch, "shuffle" (re-seed). Neural output varies per render, and
  that's a feature; seed makes it reproducible.
- **Exports**: self-contained animated SVG (CSS keyframes, real pen pacing),
  GIF/WebM, static SVG/PNG, **raw strokes JSON**. v1.5: Lottie (trim-paths maps
  1:1 to our dash technique).
- **Live writing animation** with authentic per-timestep pacing (the model
  emits fixed-interval points; we've already built and validated this
  renderer twice).

### Features (v2: the moat)

- **"Write in my handwriting"**: user writes one line on phone/tablet, then
  gets style-primed generation. Two tiers:
  - v2.0: priming the Graves-class model (works today, same-writer *idiom*)
  - v2.5: DiffInk retrained on English, one-shot style cloning with
    full-line layout fidelity (see Engine strategy)
- **Embeddable renderer** (npm package) plus an HTTP API for generation.
- Multilingual via the tegaki engine (Arabic, Hebrew, Devanagari, CJK):
  scripts the neural engine can't do.

## Engine strategy: "can we use the newer tech?"

Yes, in layers:

| Phase | Engine | Basis | Status |
|---|---|---|---|
| v1 | Graves RNN, client-side (TS or ONNX WASM) | MLX-port weights converted; X-rayLaser toolkit (MIT) as ONNX fallback | Proven: we ran generation locally this week; calligrapher.ai proves 2.6MB in-browser inference in production |
| v1 dev tool | MLX port | breitburg/graves-handwriting-mlx (submodule) | Verified working on our machine, 13 styles, clean stroke API |
| v2.5 | DiffInk (ICLR 2026): latent diffusion transformer, full-line ink, one-shot style | MIT code, active repo | Weights are Chinese-only; English = retrain on IAM-OnDB (multi-GPU, evaluate-first) |
| quality booster | sample-and-rank (Google, ICDAR 2023) | generate N, score with handwriting recognizer, keep best | Cheap, model-agnostic, roughly halves error rate |

Key architecture decision this enables: **v1 can be a static site.** Neural
inference in-browser, tegaki in-browser, exports generated client-side.
Backend only for share links, saved pieces, and later the API. Near-zero
serving cost.

**[OPEN] Client-side-only v1, or thin API from day one?** Draft: client-side
only; add API when a paying developer asks.

## Known model limitations (v1, honest list)

- English only; the alphabet lacks uppercase Q, X, Z and some punctuation
  (IAM data gap). Needs input validation/substitution UX.
- 75 chars/line; multi-line = per-line generation.
- Style priming is not faithful cloning (v2.5 fixes this).
- tegaki engine: deterministic, stamped-glyph look. Positioned as "font
  calligraphy," not "handwriting."

## Risks

1. **Licensing (deferred, not gone).** The sjvasquez weights lineage is
   unlicensed; IAM-OnDB is research-only. Commercial path: train our own
   weights (X-rayLaser pipeline, days on one GPU) on data we license/collect;
   InkSight (Apache-2.0) can bootstrap stroke data from images. Decide before
   charging money.
2. **DiffInk retrain uncertainty.** Quality on English is unproven until we
   run it. Mitigation: evaluate the Chinese checkpoint first (a one-day
   exercise); the v2.0 priming path doesn't depend on it.
3. **Competition.** Scriptum (solo dev, TS reimplementation) is being built in
   public right now; tegaki could add a neural engine. Speed matters.
4. **tegaki dependency**: MIT, healthy, but pin versions and wrap it behind
   our IR so it's swappable.

## Phasing

See [plan.md](plan.md) for the detailed build order.

- **Phase 0 (done, spike):** model runs (container + native MLX); the
  stroke-to-animated-SVG exporter built and validated; competitive landscape.
- **Phase 1, MVP (~4 wks):** web app: text box → neural generation
  (in-browser) → live animation → animated SVG + GIF + strokes JSON export;
  13 styles; bias/speed/width/color controls; shareable links.
- **Phase 2 (~+3 wks):** tegaki engine + font style gallery; Lottie export;
  embeddable renderer package; polish (paper textures, nib profiles via
  perfect-freehand).
- **Phase 3:** own-handwriting priming (tablet capture); own trained weights;
  API; DiffInk evaluation → go/no-go on v2.5 style cloning.

## Business model **[OPEN]**

Draft assumption: free tier (watermarkless SVG at modest length, all styles),
then Pro (long texts, HD GIF/WebM, Lottie, batch, API keys). Alternatives:
pure API/SDK play; one-time purchase. Needs discussion.

## Open questions (iterate on these)

1. Primary audience: creators vs developers first?
2. Client-side-only v1 or API from day one?
3. Business model (above).
4. Name. "Cali" collides with calligrapher.ai mindshare: asset or liability?
5. How early to invest in own training data (it de-risks licensing and
   enables commercial weights): Phase 1 parallel track or Phase 3?
6. Mobile capture for own-handwriting: PWA canvas or native app?
