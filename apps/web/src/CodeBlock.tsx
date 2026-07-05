import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A code block with a copy button: monospace, horizontally scrollable,
 * comments dimmed with a tiny line-based pass (no highlighter dependency —
 * the snippets are short and the comments carry the annotations that
 * matter, so they get the emphasis).
 */
export default function CodeBlock({ code, className }: { code: string; className?: string }) {
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
      <pre className="overflow-x-auto px-4 py-3.5 text-xs leading-relaxed text-zinc-100">
        <code>
          {code.split("\n").map((line, index) => {
            // "//" at line start or after whitespace — not a URL's "://".
            const match = /(^|\s)\/\//.exec(line);
            const comment = match ? match.index + match[1]!.length : -1;
            return (
              <span key={index} className="block whitespace-pre">
                {comment >= 0 ? (
                  <>
                    {line.slice(0, comment)}
                    <span className="text-zinc-500">{line.slice(comment)}</span>
                  </>
                ) : (
                  line || " "
                )}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
