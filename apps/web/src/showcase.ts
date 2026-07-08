/**
 * The use-case gallery's takes: every vignette on #/uses is one full
 * SnippetParams take, so the staged scene, its "remix in studio" share
 * link, and its code dialog all describe the exact same strokes. The
 * scenes themselves are prerendered by scripts/gen-showcase.ts into
 * src/showcase/<id>.svg (committed, so builds never need the models);
 * rerun `pnpm gen:showcase` after changing anything here.
 *
 * A take with `ink: null` renders as `currentColor` and follows the
 * page theme when inlined; takes with a fixed ink sit on scenes that
 * bring their own paper, so they look the same in both themes.
 */

import type { SnippetParams } from "./snippets.js";

export interface ShowcaseItem {
  /** Slug: the prerendered SVG's filename and the card's react key. */
  id: string;
  /** Card title, in the studio's lowercase voice. */
  title: string;
  /** One or two sentences under the scene: the pitch, plus any honesty
   * the scene owes its users. */
  caption: string;
  take: SnippetParams;
}

// Mirrors App.tsx's LEGIBILITY map; a take carries both the label (for
// share links) and the number (for emitted code).
const BIAS = { low: 0.2, normal: 0.6, high: 0.9 } as const;

const take = (
  params: Omit<SnippetParams, "bias" | "legibility"> & { legibility: keyof typeof BIAS },
): SnippetParams => ({ ...params, bias: BIAS[params.legibility] });

export const SHOWCASE: ReadonlyArray<ShowcaseItem> = [
  {
    id: "hello",
    title: "the hello",
    caption:
      "an onboarding screen that writes its greeting instead of fading it in: one word at half speed, light ink on a dark screen.",
    take: take({
      engine: "calligrapher",
      text: "hello",
      legibility: "high",
      style: 8,
      seed: 7,
      renderer: "ribbon",
      thickness: 1,
      speed: 0.5,
      ink: "#f2f2f7",
      paper: "#101017",
    }),
  },
  {
    id: "signature",
    title: "the signature",
    caption:
      "a name drawn onto the signature line after the terms are accepted. the typed name is the legal act; the ink is presentation on top of it.",
    take: take({
      engine: "graves",
      text: "Jordan Ellis",
      legibility: "normal",
      style: 11,
      seed: 1913,
      renderer: "pen",
      thickness: 1,
      speed: 1,
      ink: "#1e4fd8",
      paper: "#ffffff",
    }),
  },
  {
    id: "postscript",
    title: "the handwritten p.s.",
    caption:
      "a typed email that ends in a handwritten line. generation runs client-side, so each recipient can get a personalized line without a server.",
    take: take({
      engine: "graves",
      text: "P.S. you're going to love this",
      legibility: "normal",
      style: 3,
      seed: 271,
      renderer: "pen",
      thickness: 1,
      speed: 1,
      ink: "#1e4fd8",
      paper: "#ffffff",
    }),
  },
  {
    id: "greeting",
    title: "the greeting card",
    caption:
      "a birthday message drawn at pen speed, exported as GIF or MP4 for a chat thread. the studio's export dialog produces these files directly.",
    take: take({
      engine: "calligrapher",
      text: "happy birthday, june!",
      legibility: "normal",
      style: 4,
      seed: 512,
      renderer: "ribbon",
      thickness: 1,
      speed: 1,
      ink: "#b3261e",
      paper: "#f7f2e7",
    }),
  },
  {
    id: "gamenote",
    title: "the note in the game",
    caption:
      "a letter from a character, scrawled in freehand at low legibility. quest journals, escape-room clues, anything that should feel found rather than typeset.",
    take: take({
      engine: "graves",
      text: "meet me at midnight",
      legibility: "low",
      style: null,
      seed: 31337,
      renderer: "pen",
      thickness: 1,
      speed: 1,
      ink: "#7a4a21",
      paper: "#f0e6cf",
    }),
  },
  {
    id: "empty",
    title: "the empty state",
    caption:
      "an empty state that writes its message instead of showing a placeholder. this take sets no ink color, so it inherits the page theme.",
    take: take({
      engine: "calligrapher",
      text: "nothing here yet",
      legibility: "normal",
      style: 2,
      seed: 12,
      renderer: "pen",
      thickness: 1,
      speed: 1,
      ink: null,
      paper: null,
    }),
  },
];
