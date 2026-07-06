import { useState } from "react";
import { CodeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import CodeBlock from "./CodeBlock.js";
import { ChipLabel, chipClass, Segmented, useCloseOnHashNavigate } from "./controls.js";
import { PLATFORMS, snippetFor, type Platform, type SnippetParams } from "./snippets.js";

/**
 * The workbench payoff, sitting opposite export on the paper: the same
 * finished take, as SDK code instead of a file. The engines are
 * parity-locked across TypeScript and Swift, so the emitted seed
 * reproduces this exact take anywhere.
 *
 * The platform choice lives in App, not here: this dialog unmounts while
 * the worker generates (the trigger only exists once a take does), and a
 * Swift developer shouldn't have to reselect Swift after every write.
 */
export default function CodeDialog({
  params,
  platform,
  onPlatformChange,
}: {
  params: SnippetParams;
  platform: Platform;
  onPlatformChange: (platform: Platform) => void;
}) {
  const [open, setOpen] = useState(false);
  useCloseOnHashNavigate(() => setOpen(false));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            className={chipClass}
            title="use in your app"
            aria-label="use in your app"
          />
        }
      >
        <CodeIcon />
        <ChipLabel>use in your app</ChipLabel>
      </DialogTrigger>
      {/* The snippet is the tallest and widest thing the dialog system holds:
          cap the height on short viewports, and let the code block shrink
          below its content width (grid children won't, by default) so the
          pre's own horizontal scroll can take over. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>use in your app</DialogTitle>
          <DialogDescription>
            this exact take as code · seed {params.seed}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <Segmented
            aria-label="platform"
            options={PLATFORMS}
            value={platform}
            onChange={onPlatformChange}
          />
          <span className="text-xs">
            same seed, same strokes · the engines are parity-locked across platforms
          </span>
        </div>
        <CodeBlock className="min-w-0" code={snippetFor(platform, params)} />
        <p className="text-xs text-muted-foreground">
          write with a <span className="font-medium">locked</span> seed to keep this take ·{" "}
          <a className="underline underline-offset-2 hover:text-foreground" href="#/build">
            full setup guide
          </a>
        </p>
      </DialogContent>
    </Dialog>
  );
}
