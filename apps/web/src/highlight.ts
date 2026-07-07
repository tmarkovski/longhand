/**
 * A tiny lexer for the snippet languages — no highlighter dependency. The
 * blocks it colors all come out of snippets.ts (or the hand-written setup
 * snippets beside it), so the token shapes are known in advance: line
 * comments, double-quoted strings with escapes, numbers, keywords, and
 * capitalized type names. One shared scanner covers all four languages;
 * only the keyword set differs.
 *
 * Strings are consumed before comments, so a `//` inside a URL literal
 * stays string-colored and a real trailing comment on the same line still
 * dims — the left-to-right pass resolves what a per-line regex can't.
 */

export type SnippetLang = "ts" | "swift" | "kotlin" | "shell";

export type TokenKind = "keyword" | "type" | "string" | "number" | "comment" | "plain";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS: Record<SnippetLang, ReadonlySet<string>> = {
  ts: new Set([
    "import",
    "from",
    "export",
    "const",
    "let",
    "new",
    "async",
    "await",
    "function",
    "return",
    "null",
    "true",
    "false",
  ]),
  swift: new Set(["import", "let", "var", "func", "try", "return", "nil", "true", "false"]),
  kotlin: new Set(["import", "val", "var", "fun", "return", "null", "true", "false"]),
  // The shell blocks are install one-liners; the command is the keyword.
  shell: new Set(["npm", "pnpm"]),
};

// String (possibly unterminated) | line comment | number (Kotlin's `u`
// suffix included) | identifier. Whatever falls between matches is plain.
const TOKEN = /"(?:[^"\\]|\\.)*"?|\/\/.*|\b\d+(?:\.\d+)?u?\b|[A-Za-z_][A-Za-z0-9_]*/g;

function kindOf(text: string, keywords: ReadonlySet<string>): TokenKind {
  if (text.startsWith('"')) return "string";
  if (text.startsWith("//")) return "comment";
  if (/^\d/.test(text)) return "number";
  if (keywords.has(text)) return "keyword";
  if (/^[A-Z]/.test(text)) return "type";
  return "plain";
}

/** Split one line of code into colored runs; concatenating them restores
 * the line exactly, so the block stays copy-safe. */
export function tokenizeLine(line: string, lang: SnippetLang): Token[] {
  const tokens: Token[] = [];
  const keywords = KEYWORDS[lang];
  let cursor = 0;
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(line); match !== null; match = TOKEN.exec(line)) {
    if (match.index > cursor) {
      tokens.push({ kind: "plain", text: line.slice(cursor, match.index) });
    }
    tokens.push({ kind: kindOf(match[0], keywords), text: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) tokens.push({ kind: "plain", text: line.slice(cursor) });
  return tokens;
}
