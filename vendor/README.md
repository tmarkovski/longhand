# vendor

Third-party code and assets kept for internal evaluation. Nothing in this
directory is covered by our license, gets bundled into the app, or is part of
the Pages deploy (which ships only `apps/web/dist`). Do not publish or
redistribute anything from here without resolving licensing first.

## Contents

- `calligrapher-ai/` — full snapshot of https://www.calligrapher.ai/
  (Sean Vasquez, pulled 2026-07-03): the inline JS inference engine, the
  2.53 MB `d.bin` sparse weight container, a beautified copy of the engine
  for porting, a `d.bin` parser, a Playwright smoke test, and a `run.html`
  that runs the demo fully offline. Unlicensed; ported as
  `@longhand/ink-calligrapher`, with this snapshot serving as the
  bit-for-bit parity oracle for the port's tests. See
  `calligrapher-ai/readme.md` for the reverse-engineered architecture and
  how to run the local demo.
