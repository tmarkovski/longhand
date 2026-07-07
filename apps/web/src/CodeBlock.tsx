import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { tokenizeLine, type SnippetLang, type TokenKind } from "./highlight.js";

/**
 * A code block with a copy button: monospace, horizontally scrollable,
 * syntax-colored by the tiny lexer in highlight.ts (no highlighter
 * dependency — the snippets are machine-generated, so a handful of token
 * shapes covers them). Comments stay the dimmest run: they carry the
 * annotations that matter, but the code is the point.
 */

/** The block is always near-black, whatever the theme, so the token colors
 * are fixed: keywords in the site's ink indigo, the rest kept muted enough
 * that the comments still read as the quiet layer. */
const TOKEN_CLASS: Record<Exclude<TokenKind, "plain">, string> = {
  keyword: "text-indigo-300",
  type: "text-teal-300",
  string: "text-amber-200",
  number: "text-rose-300",
  comment: "text-zinc-400",
};

export default function CodeBlock({
  code,
  language,
  className,
}: {
  code: string;
  language: SnippetLang;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (permissions, http); the text stays
      // selectable, so manual copy still works.
    }
  }

  return (
    <div className={cn("relative rounded-2xl bg-[oklch(0.205_0_0)] dark:bg-[oklch(0.17_0_0)]", className)}>
      <button
        type="button"
        className="absolute top-2.5 right-2.5 cursor-pointer rounded-md bg-white/10 p-1.5 text-zinc-300 transition-colors hover:bg-white/20 hover:text-white"
        aria-label={copied ? "copied" : "copy code"}
        title={copied ? "copied" : "copy code"}
        onClick={copy}
      >
        {copied ? <CheckIcon className="size-3.5" aria-hidden /> : <CopyIcon className="size-3.5" aria-hidden />}
      </button>
      {/* tabIndex: the block scrolls sideways on narrow screens, and a
          scroll container must be focusable to scroll by keyboard. */}
      <pre tabIndex={0} className="overflow-x-auto px-4 py-3.5 text-xs leading-relaxed text-zinc-100">
        <code>
          {code.split("\n").map((line, index) => (
            <span key={index} className="block whitespace-pre">
              {line === ""
                ? " "
                : tokenizeLine(line, language).map((token, position) =>
                    token.kind === "plain" ? (
                      token.text
                    ) : (
                      <span key={position} className={TOKEN_CLASS[token.kind]}>
                        {token.text}
                      </span>
                    ),
                  )}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
