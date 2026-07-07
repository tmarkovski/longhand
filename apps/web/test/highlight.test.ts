import { describe, expect, it } from "vitest";
import { tokenizeLine, type SnippetLang, type TokenKind } from "../src/highlight.js";
import {
  NPM_INSTALL,
  kotlinSnippet,
  swiftSnippet,
  tsSnippet,
  type SnippetParams,
} from "../src/snippets.js";

/** A take with every option set, so the generators emit their full shape. */
const PARAMS: SnippetParams = {
  engine: "calligrapher",
  text: "hello there",
  bias: 0.6,
  legibility: "normal",
  style: null,
  seed: 42,
  renderer: "ribbon",
  thickness: 1,
  speed: 1,
  ink: "#1e4fd8",
  paper: "#e9f1f7",
};

const SNIPPETS: Array<{ lang: SnippetLang; code: string }> = [
  { lang: "ts", code: tsSnippet(PARAMS) },
  { lang: "ts", code: tsSnippet({ ...PARAMS, engine: "graves", renderer: "pen", ink: null }) },
  { lang: "swift", code: swiftSnippet(PARAMS) },
  { lang: "kotlin", code: kotlinSnippet(PARAMS) },
  { lang: "shell", code: NPM_INSTALL },
];

function kinds(line: string, lang: SnippetLang): TokenKind[] {
  return tokenizeLine(line, lang).map((token) => token.kind);
}

describe("tokenizeLine", () => {
  it("round-trips every line of every generated snippet", () => {
    for (const { lang, code } of SNIPPETS) {
      for (const line of code.split("\n")) {
        const joined = tokenizeLine(line, lang)
          .map((token) => token.text)
          .join("");
        expect(joined).toBe(line);
      }
    }
  });

  it("colors the shapes each language leans on", () => {
    // TS: import machinery, string module paths, a trailing comment.
    expect(tokenizeLine('import { GravesModel } from "longhand/ink-graves";', "ts")).toEqual([
      { kind: "keyword", text: "import" },
      { kind: "plain", text: " { " },
      { kind: "type", text: "GravesModel" },
      { kind: "plain", text: " } " },
      { kind: "keyword", text: "from" },
      { kind: "plain", text: " " },
      { kind: "string", text: '"longhand/ink-graves"' },
      { kind: "plain", text: ";" },
    ]);
    expect(kinds("  bias: 0.6, // legibility: normal", "ts")).toEqual([
      "plain",
      "plain",
      "plain",
      "number",
      "plain",
      "comment",
    ]);
    // Swift: let/try, no semicolons.
    expect(kinds("let offsets = try model.write(", "swift")).toContain("keyword");
    // Kotlin: val, the unsigned-seed literal, Double literals.
    expect(tokenizeLine("    seed = 42u,", "kotlin")).toContainEqual({
      kind: "number",
      text: "42u",
    });
    expect(kinds("val line = alignLine(offsetsToLine(offsets))", "kotlin")[0]).toBe("keyword");
    // Shell: the command reads as the keyword.
    expect(tokenizeLine(NPM_INSTALL, "shell")[0]).toEqual({ kind: "keyword", text: "npm" });
  });

  it("keeps a // inside a string literal string-colored, but dims a real trailing comment", () => {
    const tokens = tokenizeLine('    maven("https://jitpack.io") // the JitPack repo', "kotlin");
    expect(tokens).toContainEqual({ kind: "string", text: '"https://jitpack.io"' });
    expect(tokens.at(-1)).toEqual({ kind: "comment", text: "// the JitPack repo" });
  });

  it("never colors comment innards as code", () => {
    const tokens = tokenizeLine('// Or lineToSvg(line, { ...same options }) for a still image.', "ts");
    expect(tokens).toEqual([
      { kind: "comment", text: '// Or lineToSvg(line, { ...same options }) for a still image.' },
    ]);
  });
});
