import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** The paper's action chips (play, share, code, export): icon circles that
 * unroll into a labeled pill under the pointer or keyboard focus — the
 * animation lives in styles.css (.chip / .chip-label). Raised off the paper
 * by shadow rather than drawn with a border, the same language as the paper
 * card itself; in dark themes shadows can't lift, so the surface goes one
 * step lighter than the card instead. Borderless, the 32px circle is icon
 * (16) + padding (16).
 *
 * Each chip is absolutely anchored inside a fixed 32px slot (chipSlotClass
 * on the wrapper), so the unrolling pill expands OVER the strip instead of
 * pushing its neighbors — a pointer traveling the row never has its target
 * move away from it. Left-anchored chips unroll rightward; right-anchored
 * ones pin the icon at the right edge and roll the label out to its left
 * (.chip-reverse flips the flex order and the label's gap side). */
const chipClass =
  "chip h-8 gap-0 rounded-full border-0 bg-white/90 px-2 shadow-sm dark:bg-muted/90 dark:hover:bg-[oklch(0.32_0_0)]";
export const chipSlotClass = "relative size-8 shrink-0";
// w-max: an absolute element shrink-wraps against its containing block (the
// 32px slot), which would clamp the unroll; max-content sizes it to its own
// icon + label instead.
export const chipLeftClass = cn(chipClass, "absolute top-0 left-0 w-max");
export const chipRightClass = cn(chipClass, "chip-reverse absolute top-0 right-0 w-max");

/** A chip's unrolling label. Hidden from the accessibility tree: the chips
 * carry a stable aria-label, and this text comes and goes with hover. */
export function ChipLabel({ children }: { children: ReactNode }) {
  return (
    <span className="chip-label" aria-hidden>
      {/* Inner span so the grid column can clip it while it unrolls. */}
      <span>{children}</span>
    </span>
  );
}

/** Close a portaled dialog on any hash navigation. The dialogs render
 * above the hash router (portaled to body), and the studio stays mounted
 * under the guide, so nothing else would close them: an open modal would
 * ride along — backdrop, scroll lock and all — on top of the other page.
 * Covers in-dialog links, the header pill, and browser back/forward. */
export function useCloseOnHashNavigate(close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onHashChange = () => closeRef.current();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
}

/** iOS-style segmented control: a radiogroup whose selected pill slides to
 * the picked option. The pill is measured off the selected button, so it
 * tracks variable label widths and the flex-stretched mobile layout. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const index = options.findIndex((option) => option.value === value);

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const update = () => {
      const button = group.querySelectorAll<HTMLElement>("[role=radio]")[index];
      setPill(button ? { left: button.offsetLeft, width: button.offsetWidth } : null);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(group);
    return () => observer.disconnect();
  }, [index, options]);

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className="relative inline-flex rounded-full bg-white/80 p-0.5 shadow-xs max-sm:flex-1 dark:bg-background/40"
    >
      {pill && (
        <span
          aria-hidden
          className="absolute top-0.5 bottom-0.5 rounded-full bg-primary transition-[left,width] duration-200 ease-out"
          style={{ left: pill.left, width: pill.width }}
        />
      )}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={cn(
            "relative cursor-pointer rounded-full px-3 py-1 text-xs transition-colors max-sm:flex-1",
            option.value === value
              ? "text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type Theme = "system" | "light" | "dark";

const THEME_ICONS = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

/** One button cycling system → light → dark; the icon is the state. The
 * saved choice is applied before first paint by the inline script in
 * index.html, so this only has to keep the class and storage in sync.
 * `onApply` fires after the class changes, so the canvas can repaint
 * theme-dependent ink. */
export function ThemeToggle({ onApply }: { onApply?: () => void }) {
  // Ref-routed so the media listener never calls a stale closure.
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("theme");
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && media.matches),
      );
      onApplyRef.current?.();
    };
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  function cycle() {
    const next: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    setTheme(next);
    try {
      if (next === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {
      // Storage may be unavailable (private mode); the toggle still works
      // for the session.
    }
  }

  const Icon = THEME_ICONS[theme];
  return (
    <button
      type="button"
      className="cursor-pointer rounded-full p-1 transition-colors hover:text-foreground"
      title={`theme: ${theme}`}
      aria-label={`theme: ${theme}`}
      onClick={cycle}
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}
