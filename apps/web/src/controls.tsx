import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CoffeeIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { REPO_URL } from "./snippets.js";

/** The paper's action chips (play, share, code, export): icon circles that
 * unroll into a labeled pill under the pointer or keyboard focus — the
 * animation lives in styles.css (.chip / .chip-label). Raised off the paper
 * by shadow rather than drawn with a border, the same language as the paper
 * card itself; in dark themes shadows can't lift, so the surface goes one
 * step lighter than the card instead. Borderless, the 32px circle is icon
 * (16) + padding (16).
 *
 * Chips whose neighbors are buttons are absolutely anchored inside a fixed
 * 32px slot (chipSlotClass on the wrapper), so the unrolling pill expands
 * OVER the strip instead of pushing them — a pointer traveling the row
 * never has its target move away from it. Right-anchored chips pin the
 * icon at the right edge and roll the label out to its left (.chip-reverse
 * flips the flex order and the label's gap side).
 *
 * A chip whose only neighbor is text (the play chip, beside the status
 * line) stays IN flow: its left edge holds still while the pill grows
 * rightward, and the text rides the same width transition out and back. */
export const chipClass =
  "chip h-8 gap-0 rounded-full border-0 bg-card/90 px-2 shadow-sm dark:bg-muted/90 dark:hover:bg-[oklch(0.32_0.012_70)]";
export const chipSlotClass = "relative size-8 shrink-0";
// w-max: an absolute element shrink-wraps against its containing block (the
// 32px slot), which would clamp the unroll; max-content sizes it to its own
// icon + label instead.
export const chipRightClass = cn(chipClass, "chip-reverse absolute top-0 right-0 w-max");

/** A chip's unrolling label. Hidden from the accessibility tree: the chips
 * carry a stable aria-label, and this text comes and goes with hover. */
export function ChipLabel({ children }: { children: ReactNode }) {
  return (
    <span className="chip-label" aria-hidden>
      {/* Inner span so the grid column can clip it while it unrolls;
          nowrap so multi-word labels clip instead of stacking. */}
      <span className="whitespace-nowrap">{children}</span>
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
      className="relative inline-flex rounded-full bg-card/80 p-0.5 shadow-xs max-sm:flex-1 dark:bg-background/40"
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

export const COFFEE_URL = "https://buymeacoffee.com/codewithtm";

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith("http");
  return (
    <a
      className="whitespace-nowrap underline underline-offset-2 hover:text-foreground"
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

/** The GitHub mark (lucide dropped its brand icons), inheriting text color
 * like a lucide icon would. Path from GitHub's own octicons (MIT). */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** The pages, as the footer names them; each page links to the others. */
const PAGE_LINKS = [
  { page: "studio", href: "#/", label: "studio" },
  { page: "uses", href: "#/uses", label: "what it's for" },
  { page: "build", href: "#/build", label: "build with it" },
] as const;

/** An icon-circle link in the letterhead, unrolling its label on hover in
 * the paper strip's chip language — but IN flow, like the play chip, so
 * the growth pushes the nav links along and rides them back (an overlay
 * smeared its label over the neighbors'). chip-reverse pins the icon and
 * rolls the label out to its LEFT; the letterhead cluster is pinned to
 * the container's right edge, so both icons hold perfectly still on
 * screen while only the links slide. Sized to the nav's quiet scale
 * (28px), not the strip's 32. */
function HeaderChip({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <a
      className="chip chip-reverse flex shrink-0 items-center rounded-full bg-card/80 p-1.5 text-xs text-muted-foreground shadow-xs transition-colors hover:text-foreground dark:bg-background/40 dark:hover:bg-[oklch(0.32_0.012_70)]"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
    >
      {children}
      {/* Padding inside the label so it unrolls with the text: the chip's
          p-1.5 is icon-circle padding, too tight against the pill's
          rounded cap (the far cap is the left one here). */}
      <ChipLabel>
        <span className="pl-1.5">{label}</span>
      </ChipLabel>
    </a>
  );
}

function formatStars(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(count);
}

/** The star count for the letterhead's GitHub chip: fetched once, cached
 * in localStorage for six hours (404s too, so a private repo costs one
 * request per visitor per window). Null until known — and it stays null
 * while the repo is private, so the chip is simply an icon circle until
 * the repo opens up and the count lights up on its own. */
function useGithubStars(): string | null {
  const [stars, setStars] = useState<string | null>(null);
  useEffect(() => {
    const KEY = "gh-stars";
    const TTL = 6 * 60 * 60 * 1000;
    try {
      const cached = JSON.parse(localStorage.getItem(KEY) ?? "null") as {
        count: number | null;
        at: number;
      } | null;
      if (cached && Date.now() - cached.at < TTL) {
        // A zero would read worse than no badge; show counts from 1 up.
        if (typeof cached.count === "number" && cached.count > 0)
          setStars(formatStars(cached.count));
        return;
      }
    } catch {
      // Unreadable cache; fall through to the fetch.
    }
    let cancelled = false;
    fetch(REPO_URL.replace("https://github.com/", "https://api.github.com/repos/"))
      .then((res) => (res.ok ? res.json() : null))
      .then((repo: { stargazers_count?: number } | null) => {
        const count = typeof repo?.stargazers_count === "number" ? repo.stargazers_count : null;
        try {
          localStorage.setItem(KEY, JSON.stringify({ count, at: Date.now() }));
        } catch {
          // Storage may be unavailable (private mode).
        }
        if (!cancelled && count !== null && count > 0) setStars(formatStars(count));
      })
      .catch(() => {
        // Offline is fine; the chip stays an icon.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return stars;
}

/** The letterhead all pages share: the wordmark on the left, the other
 * pages and the support links on the right — the footer's voice lifted to
 * the top of the page. On the studio the wordmark is the page's h1; on
 * the other pages it shrinks into a link home (their own titles keep the
 * h1) and replaces the old one-off back-to-the-studio links. The row
 * wraps on narrow screens; ml-auto keeps the nav right-aligned even when
 * it drops to its own line. */
export function SiteHeader({ page }: { page: (typeof PAGE_LINKS)[number]["page"] }) {
  const stars = useGithubStars();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {page === "studio" ? (
        <h1 className="font-heading text-2xl font-medium tracking-tight italic">longhand</h1>
      ) : (
        <a
          className="font-heading text-lg font-medium tracking-tight italic transition-colors hover:text-primary"
          href="#/"
        >
          longhand
        </a>
      )}
      <nav aria-label="site" className="ml-auto flex items-center gap-4">
        {PAGE_LINKS.filter((link) => link.page !== page).map((link) => (
          <a
            key={link.page}
            className="py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            href={link.href}
          >
            {link.label}
          </a>
        ))}
        <span className="flex items-center gap-2">
          <HeaderChip href={COFFEE_URL} label="buy me a coffee">
            <CoffeeIcon className="size-4 shrink-0" aria-hidden />
          </HeaderChip>
          <HeaderChip href={REPO_URL} label="star on github">
            {/* The chip is row-reversed, so DOM order runs right-to-left:
                the count first (far right), then the mark — reading as
                mark-then-count, the badge convention. Physical padding
                doesn't flip with flex order, so pl-1 is the gap between
                them. */}
            {stars !== null && <span className="pl-1">{stars}</span>}
            <GithubMark className="size-4 shrink-0" />
          </HeaderChip>
        </span>
      </nav>
    </div>
  );
}

/** The footer all pages share: page links on the left, an icon cluster —
 * the repo and the theme toggle — on the right. `lead` is a page's own
 * closing words, on their own line above the links (the guide keeps its
 * weights note there) so a disclaimer doesn't read as part of the nav. */
export function SiteFooter({
  page,
  lead,
  onThemeApply,
}: {
  page: (typeof PAGE_LINKS)[number]["page"];
  lead?: ReactNode;
  onThemeApply?: () => void;
}) {
  return (
    <footer className="flex flex-col gap-1 text-xs text-muted-foreground/80">
      {lead !== undefined && <p>{lead}</p>}
      <div className="flex items-center justify-between gap-3">
        <span>
          {PAGE_LINKS.filter((link) => link.page !== page).map((link) => (
            <span key={link.page}>
              <FooterLink href={link.href}>{link.label}</FooterLink>
              {" · "}
            </span>
          ))}
          <FooterLink href={COFFEE_URL}>buy me a coffee</FooterLink>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <a
            className="rounded-full p-1 transition-colors hover:text-foreground"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="source on GitHub"
            title="source on GitHub"
          >
            <GithubMark className="size-3.5" />
          </a>
          <ThemeToggle onApply={onThemeApply} />
        </span>
      </div>
    </footer>
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
