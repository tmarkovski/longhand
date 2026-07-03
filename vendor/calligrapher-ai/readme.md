# calligrapher.ai vendor snapshot

Snapshot of https://www.calligrapher.ai/ (Sean Vasquez), pulled 2026-07-03.
Unlicensed third-party code and weights. `d.bin` is the source of truth for
the app's calligrapher engine (`@longhand/ink-calligrapher` is a bit-exact TS
port, parity-tested against `engine.pretty.js`); the deploy copies it to
`apps/web/public/model/calligrapher-v1.bin`. Licensing is unresolved and must
be settled (permission from the author, or our own training run) before
monetizing — see docs/plan.md.

## Files

- `index.html` — pristine original page. Everything is inline: styles, UI, and
  the full inference engine (~10 KB minified JS). The only external requests
  are Google Analytics, Google Fonts, and `/d.bin`.
- `d.bin` — the model, 2.53 MB, sha256 `7e804513...373b50a79d`. Custom binary
  container of sparse-pruned float32 tensors (format documented in
  `parse_d_bin.py`).
- `run.html` — `index.html` with the Google Analytics and Google Fonts tags
  removed, so local testing makes no external requests. Run with
  `python3 -m http.server` in this folder and open `/run.html` (the page
  fetches `/d.bin` by absolute path, so serve from this folder).
- `engine.pretty.js` — beautified copy of the inline engine, for porting.
- `parse_d_bin.py` — parses `d.bin`, prints the tensor inventory, optionally
  dumps dense tensors to `.npz`.

## Model architecture (reverse-engineered)

Graves-style handwriting synthesis, but not the public
sjvasquez/handwriting-synthesis checkpoint (that is what `graves-v1.bin`
descends from). This deployed model differs:

- 3 LSTM layers, hidden 256 (vs our 3x400), input/recurrent kernels magnitude
  pruned to ~20% density, sqrt(0.5)-scaled skip connections between layers.
- Text conditioning: learned 85x256 char embedding -> width-3 conv encoder ->
  512->256 projection, attended by a 10-component Gaussian window
  (kappa += softplus/15).
- Output: 20-component bivariate MDN + pen bit (121 outputs), same head shape
  as ours.
- Styles: 80 learned 64-dim style embeddings (`g`), projected by `k`/`R` and
  added to the input projection each step. No stroke priming; style switching
  is instant. The site UI exposes only styles 0-9 plus random.
- Charset: 85 symbols (see `H` map in the engine), includes uppercase Q/X/Z
  which ours lacks.

Tensor letters -> roles: `s` char embedding, `b`/`t` conv encoder, `j`/`E` and
`l`/`Q` text projections, `y`/`p` `w`/`q` `r`/`f` LSTM1-3 kernels/biases,
`i`/`W` input projection, `h`/`n` attention, `z`/`v` MDN head, `c`/`u` pen
head, `g`/`k`/`R` styles, `d o e m x a T` initial LSTM/attention state.
