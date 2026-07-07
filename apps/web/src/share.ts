/**
 * Share links: a whole take — text, engine, look, and seed — packed into a
 * #/write URL, so opening it writes the same line, stroke for stroke. The
 * hash keeps GitHub Pages happy (no rewrites), and the params read as
 * plain words so a pasted link says what it will do.
 */

import type { EngineId, RendererKind } from "./protocol.js";
import type { SnippetParams } from "./snippets.js";

/** The URL speaks the UI's names: the graves engine is "longhand"
 * everywhere users see it (the internal id is accepted on parse too). */
const ENGINE_NAMES: Record<EngineId, string> = {
  graves: "longhand",
  calligrapher: "calligrapher",
};

const LEGIBILITIES = ["low", "normal", "high"] as const;
export type ShareLegibility = (typeof LEGIBILITIES)[number];

// Mirrors App.tsx's DEFAULT_THICKNESS / DEFAULT_SPEED and the slider ranges.
const THICKNESS_RANGE = { min: 0.5, max: 1.5, fallback: 1 };
const SPEED_RANGE = { min: 0.25, max: 4, fallback: 1 };

/** A parsed share link. Null style/stroke mean "the engine's default";
 * null seed means the link didn't pin one (roll a fresh take); null
 * ink/paper mean "no color". */
export interface SharedTake {
  engine: EngineId;
  text: string;
  legibility: ShareLegibility;
  style: number | null;
  stroke: RendererKind | null;
  seed: number | null;
  ink: string | null;
  paper: string | null;
  thickness: number;
  speed: number;
}

const fmt = (value: number) => String(Number(value.toFixed(2)));

/** The take → the hash half of a share link: an in-app href (the
 * use-case gallery's "remix in studio") navigates by hash alone. */
export function shareHash(params: SnippetParams): string {
  const query = new URLSearchParams();
  query.set("text", params.text);
  query.set("model", ENGINE_NAMES[params.engine]);
  if (params.style !== null) query.set("style", String(params.style));
  query.set("legibility", params.legibility);
  query.set("stroke", params.renderer);
  if (params.ink) query.set("ink", params.ink);
  if (params.paper) query.set("paper", params.paper);
  query.set("thickness", fmt(params.thickness));
  query.set("speed", fmt(params.speed));
  query.set("seed", String(params.seed));
  return `#/write?${query}`;
}

/** The take → a full link. Built from the same params object the code
 * panel uses, so share and snippet can never disagree about what a take
 * is. */
export function buildShareUrl(params: SnippetParams): string {
  return `${location.origin}${location.pathname}${shareHash(params)}`;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseColor(value: string | null): string | null {
  return value !== null && HEX_COLOR.test(value) ? value.toLowerCase() : null;
}

function parseRange(
  value: string | null,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, min), max)
    : fallback;
}

/** Read a #/write link back into a take; null for any other hash, or when
 * the link carries no text (nothing to write). Unknown or out-of-range
 * values fall back to defaults instead of failing: a hand-mangled link
 * should still write its text. */
export function parseSharedTake(hash: string): SharedTake | null {
  if (hash !== "#/write" && !hash.startsWith("#/write?")) return null;
  const query = new URLSearchParams(hash.slice("#/write?".length));
  const text = query.get("text") ?? "";
  if (text.trim().length === 0) return null;

  const model = query.get("model");
  const legibility = query.get("legibility") ?? "";
  const style = query.get("style");
  const stroke = query.get("stroke");
  const seed = query.get("seed");
  return {
    engine: model === "longhand" || model === "graves" ? "graves" : "calligrapher",
    text,
    legibility: (LEGIBILITIES as readonly string[]).includes(legibility)
      ? (legibility as ShareLegibility)
      : "normal",
    style: style !== null && /^\d+$/.test(style) ? Number(style) : null,
    stroke: stroke === "pen" || stroke === "ribbon" ? stroke : null,
    seed: seed !== null && /^\d+$/.test(seed) ? Math.min(Number(seed), 4294967295) : null,
    ink: parseColor(query.get("ink")),
    paper: parseColor(query.get("paper")),
    thickness: parseRange(query.get("thickness"), THICKNESS_RANGE),
    speed: parseRange(query.get("speed"), SPEED_RANGE),
  };
}
