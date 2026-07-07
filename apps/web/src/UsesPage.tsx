import { useState, type ReactNode } from "react";
import { CheckIcon, CodeIcon, PenLineIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import CodeBlock from "./CodeBlock.js";
import { Segmented, SiteFooter, SiteHeader, useCloseOnHashNavigate } from "./controls.js";
import { shareHash } from "./share.js";
import { SHOWCASE, type ShowcaseItem } from "./showcase.js";
import { PLATFORMS, snippetFor, type Platform } from "./snippets.js";
import emptySvg from "./showcase/empty.svg?raw";
import gamenoteSvg from "./showcase/gamenote.svg?raw";
import greetingSvg from "./showcase/greeting.svg?raw";
import helloSvg from "./showcase/hello.svg?raw";
import postscriptSvg from "./showcase/postscript.svg?raw";
import signatureSvg from "./showcase/signature.svg?raw";

/**
 * The use-case gallery: what handwriting synthesis is *for*, as six
 * staged scenes. Each scene is a prerendered animated SVG (committed by
 * gen:showcase, inlined here so SMIL plays and `currentColor` follows
 * the theme) of one full take from src/showcase.ts, and each card exits
 * two ways: "remix in studio" navigates a #/write share link into the
 * live studio, "get the code" opens the same snippet the studio's code
 * panel would emit. No models load on this page; the scenes cost what a
 * picture costs.
 */

const SVGS: Record<string, string> = {
  hello: helloSvg,
  signature: signatureSvg,
  postscript: postscriptSvg,
  greeting: greetingSvg,
  gamenote: gamenoteSvg,
  empty: emptySvg,
};

/** Inlined animated ink. The SVGs carry viewBox but no size, so with
 * width and height pinned to the wrapper they letterbox (preserveAspectRatio
 * "meet") inside whatever box a scene hands them. */
function Ink({ svg, text, className }: { svg: string; text: string; className?: string }) {
  return (
    <div
      role="img"
      aria-label={`"${text}" writing itself in ink`}
      className={cn("[&>svg]:h-full [&>svg]:w-full", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** A skeleton line of "typed" text, for the document-flavored scenes. */
function Bar({ className }: { className?: string }) {
  return <div aria-hidden className={cn("h-1.5 rounded-full bg-neutral-200", className)} />;
}

/** The staged chrome around each vignette. Scenes with a fixed paper
 * (splash screen, document, parchment) look the same in both themes;
 * the empty state deliberately rides the theme instead. */
function Scene({ item }: { item: ShowcaseItem }) {
  const svg = SVGS[item.id]!;
  const text = item.take.text;
  switch (item.id) {
    case "hello":
      // A first-boot screen: one word on the dark, nothing else.
      return (
        <div className="flex h-44 items-center justify-center rounded-xl bg-[#101017] px-12 py-10">
          <Ink svg={svg} text={text} className="h-full w-full" />
        </div>
      );
    case "signature":
      return (
        <div className="flex h-44 flex-col justify-end gap-2.5 rounded-xl bg-white p-4">
          <Bar className="w-2/3" />
          <Bar className="w-1/2" />
          <div className="flex items-center gap-1.5 pt-1 text-[10px] text-neutral-500">
            <span className="flex size-3 items-center justify-center rounded-[3px] bg-neutral-800">
              <CheckIcon className="size-2.5 text-white" aria-hidden />
            </span>
            I agree to the terms
          </div>
          <div className="border-b border-neutral-300 px-3">
            <Ink svg={svg} text={text} className="mx-auto h-16 max-w-60" />
          </div>
          <div className="text-[10px] text-neutral-400">signature</div>
        </div>
      );
    case "postscript":
      return (
        <div className="flex h-44 flex-col gap-2 rounded-xl bg-white p-4 text-[10px] text-neutral-400">
          <div>
            <span className="text-neutral-500">to:</span> you
          </div>
          <div className="border-b border-neutral-200 pb-1.5">
            <span className="text-neutral-500">subject:</span> a small thank you
          </div>
          <Bar className="w-full" />
          <Bar className="w-3/4" />
          <Ink svg={svg} text={text} className="mt-auto mb-1 h-11 w-full" />
        </div>
      );
    case "greeting":
      return (
        <div className="flex h-44 items-center justify-center rounded-xl bg-[#f7f2e7] px-8 py-10">
          <Ink svg={svg} text={text} className="h-full w-full" />
        </div>
      );
    case "gamenote":
      return (
        <div className="flex h-44 items-center justify-center rounded-xl bg-[#17120e] px-8">
          <div className="w-full -rotate-2 rounded-[4px] bg-[#f0e6cf] px-5 py-6 shadow-[0_10px_28px_rgba(0,0,0,0.55)]">
            <Ink svg={svg} text={text} className="h-14 w-full" />
          </div>
        </div>
      );
    case "empty":
      // currentColor ink on the theme's own card surface: the studio's
      // default ink in both palettes.
      return (
        <div className="flex h-44 flex-col gap-2.5 rounded-xl bg-card p-4 text-[#1c1c28] shadow-xs dark:text-[#ececf1]">
          <div aria-hidden className="h-6 w-full rounded-full bg-foreground/5" />
          <Ink svg={svg} text={text} className="m-auto h-12 w-full max-w-64" />
        </div>
      );
    default:
      return null;
  }
}

function UseCaseCard({ item, onCode }: { item: ShowcaseItem; onCode: (item: ShowcaseItem) => void }) {
  const exit =
    "flex cursor-pointer items-center gap-1.5 text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground";
  return (
    <article className="flex flex-col gap-3 rounded-2xl bg-[oklch(0.93_0.012_85)] p-4 shadow-sm dark:bg-[oklch(0.235_0.012_70)]">
      <Scene item={item} />
      <div className="flex flex-col gap-1.5 px-1">
        <h3 className="font-medium">{item.title}</h3>
        <p className="text-sm text-muted-foreground">{item.caption}</p>
      </div>
      <div className="mt-auto flex items-center gap-4 px-1 pb-1 text-xs">
        <a className={exit} href={shareHash(item.take)}>
          <PenLineIcon className="size-3.5" aria-hidden />
          remix in studio
        </a>
        <button type="button" className={exit} onClick={() => onCode(item)}>
          <CodeIcon className="size-3.5" aria-hidden />
          get the code
        </button>
      </div>
    </article>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

export default function UsesPage() {
  // One code dialog for the whole gallery; the platform choice survives
  // from card to card, same as the studio's panel.
  const [codeItem, setCodeItem] = useState<ShowcaseItem | null>(null);
  const [platform, setPlatform] = useState<Platform>("web");
  useCloseOnHashNavigate(() => setCodeItem(null));

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-7 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-5">
        <SiteHeader page="uses" />
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            What can you make with Longhand?
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            six little scenes, each one a real take from the engines. watch it write, remix it
            live in the studio, or copy the code that redraws it stroke for stroke in your own
            app: web, iOS, or Android.
          </p>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {SHOWCASE.map((item) => (
          <UseCaseCard key={item.id} item={item} onCode={setCodeItem} />
        ))}
      </div>

      <Section title="a take is data">
        <p className="text-sm text-muted-foreground">
          Every scene above is a handful of numbers: text, style, legibility, seed. The
          engines are parity-locked across TypeScript, Swift, and Kotlin, so those numbers
          draw the same strokes on every platform, which opens doors the vignettes only hint
          at. Derive the seed from a user id and everyone in your app writes in their own
          consistent hand. Pin a style and seed once and you have an autograph that signs
          identically on web, iOS, and Android. Send the numbers themselves, a few dozen
          bytes, and the receiving device redraws the ink natively instead of playing a
          video. The{" "}
          <a className="underline underline-offset-2 hover:text-foreground" href="#/build">
            guide
          </a>{" "}
          has the setup; and if you just want the file, the{" "}
          <a className="underline underline-offset-2 hover:text-foreground" href="#/">
            studio
          </a>{" "}
          exports any of these as still or animated SVG, PNG, GIF, or MP4.
        </p>
      </Section>

      <SiteFooter page="uses" />

      <Dialog open={codeItem !== null} onOpenChange={(open) => !open && setCodeItem(null)}>
        {codeItem !== null && (
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{codeItem.title}</DialogTitle>
              <DialogDescription>
                this exact take as code · seed {codeItem.take.seed}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <Segmented
                aria-label="platform"
                options={PLATFORMS}
                value={platform}
                onChange={setPlatform}
              />
              <span className="text-xs">
                same seed, same strokes · the engines are parity-locked across platforms
              </span>
            </div>
            <CodeBlock className="min-w-0" code={snippetFor(platform, codeItem.take)} />
            <p className="text-xs text-muted-foreground">
              full setup in{" "}
              <a className="underline underline-offset-2 hover:text-foreground" href="#/build">
                the guide
              </a>
            </p>
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}
