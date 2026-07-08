import { useRef, useState } from "react";
import {
  DownloadIcon,
  FilmIcon,
  ImageIcon,
  ImagePlayIcon,
  PenLineIcon,
  SplineIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  ChipLabel,
  chipRightClass,
  chipSlotClass,
  Segmented,
  useCloseOnHashNavigate,
} from "./controls.js";
import {
  downloadBlob,
  exportFileName,
  toAnimatedSvg,
  toGif,
  toMp4,
  toPng,
  toStaticSvg,
  videoSupported,
  type ExportFormat,
  type ExportOptions,
  type ExportStyle,
} from "./export.js";

/**
 * The export dialog: five formats in two groups (still and animation),
 * picked from a radio list and saved with one button. The selected row
 * unfolds an options panel inside its card — canvas ratio and padding for
 * every format, frame rate for the encoded videos, and the end-of-line
 * pause for anything animated. Everything renders client-side; the slow
 * encodes (GIF, MP4) stream progress into the download button and abort
 * if the dialog closes.
 */

interface FormatOption {
  format: ExportFormat;
  label: string;
  extension: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STILL: FormatOption[] = [
  {
    format: "svg",
    label: "SVG",
    extension: ".svg",
    description: "crisp vector ink, scales to any size",
    icon: SplineIcon,
  },
  {
    format: "png",
    label: "PNG",
    extension: ".png",
    description: "image, transparent without a paper color",
    icon: ImageIcon,
  },
];

const ANIMATED: FormatOption[] = [
  {
    format: "animated-svg",
    label: "animated SVG",
    extension: ".svg",
    description: "writes itself wherever it's embedded, loops",
    icon: PenLineIcon,
  },
  {
    format: "gif",
    label: "GIF",
    extension: ".gif",
    description: "loops anywhere, chat-friendly",
    icon: ImagePlayIcon,
  },
  {
    format: "mp4",
    label: "MP4",
    extension: ".mp4",
    description: "smooth video of the pen writing",
    icon: FilmIcon,
  },
];

/** Canvas shapes: tight crop, square, and the landscape/portrait classics. */
const RATIOS = [
  { value: "auto", label: "auto", ratio: null },
  { value: "1:1", label: "1:1", ratio: 1 },
  { value: "4:3", label: "4:3", ratio: 4 / 3 },
  { value: "16:9", label: "16:9", ratio: 16 / 9 },
  { value: "9:16", label: "9:16", ratio: 9 / 16 },
] as const;
type RatioKey = (typeof RATIOS)[number]["value"];

/** Whitespace presets in layout units (the ink itself is 200 tall). */
const PADDINGS = [
  { value: "snug", label: "snug", padding: 16 },
  { value: "normal", label: "normal", padding: 40 },
  { value: "airy", label: "airy", padding: 96 },
] as const;
type PaddingKey = (typeof PADDINGS)[number]["value"];

/** GIF delays tick in hundredths of a second, so only rates that divide
 * 1000ms into multiples of 10 play back at true speed. */
const GIF_RATES = [
  { value: "10", label: "10" },
  { value: "20", label: "20" },
  { value: "25", label: "25" },
] as const;
type GifRate = (typeof GIF_RATES)[number]["value"];

const MP4_RATES = [
  { value: "24", label: "24" },
  { value: "30", label: "30" },
  { value: "60", label: "60" },
] as const;
type Mp4Rate = (typeof MP4_RATES)[number]["value"];

/** One panel row: a quiet label, then the control(s) filling the rest. */
function OptionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

interface ExportDialogProps {
  text: string;
  getOffsets: () => ReadonlyArray<[number, number, number]>;
  getStyle: () => ExportStyle;
}

export default function ExportDialog({ text, getOffsets, getStyle }: ExportDialogProps) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("png");
  const [ratio, setRatio] = useState<RatioKey>("auto");
  const [padding, setPadding] = useState<PaddingKey>("normal");
  const [gifRate, setGifRate] = useState<GifRate>("25");
  const [mp4Rate, setMp4Rate] = useState<Mp4Rate>("30");
  const [holdMs, setHoldMs] = useState(1500);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const canVideo = videoSupported();

  function openChange(next: boolean) {
    if (!next) {
      // Closing cancels a running encode.
      abortRef.current?.abort();
      setError("");
    }
    setOpen(next);
  }
  useCloseOnHashNavigate(() => openChange(false));

  async function download() {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setProgress(0);
    setError("");
    try {
      const offsets = getOffsets();
      const style = getStyle();
      const options: ExportOptions = {
        ratio: RATIOS.find((choice) => choice.value === ratio)!.ratio,
        padding: PADDINGS.find((choice) => choice.value === padding)!.padding,
        fps: Number(format === "gif" ? gifRate : mp4Rate),
        holdMs,
      };
      const onProgress = (done: number, total: number) => setProgress(done / total);
      let blob: Blob;
      switch (format) {
        case "svg":
          blob = toStaticSvg(offsets, style, options);
          break;
        case "animated-svg":
          blob = toAnimatedSvg(offsets, style, options);
          break;
        case "png":
          blob = await toPng(offsets, style, options);
          break;
        case "gif":
          blob = await toGif(offsets, style, options, onProgress, controller.signal);
          break;
        case "mp4":
          blob = await toMp4(offsets, style, options, onProgress, controller.signal);
          break;
      }
      downloadBlob(blob, exportFileName(text, format));
      setOpen(false);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(String(cause instanceof Error ? cause.message : cause));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const selected = [...STILL, ...ANIMATED].find((option) => option.format === format)!;

  /** The options that make sense for `option`, as rows inside its card. */
  function optionsPanel(option: FormatOption) {
    const animated = option.format !== "svg" && option.format !== "png";
    return (
      <div
        className={cn(
          "flex flex-col gap-2 px-3 pt-1 pb-3",
          busy && "pointer-events-none opacity-50",
        )}
      >
        <OptionRow label="ratio">
          <Segmented aria-label="canvas ratio" options={RATIOS} value={ratio} onChange={setRatio} />
        </OptionRow>
        <OptionRow label="padding">
          <Segmented
            aria-label="padding"
            options={PADDINGS}
            value={padding}
            onChange={setPadding}
          />
        </OptionRow>
        {option.format === "gif" && (
          <OptionRow label="fps">
            <Segmented
              aria-label="GIF frame rate"
              options={GIF_RATES}
              value={gifRate}
              onChange={setGifRate}
            />
          </OptionRow>
        )}
        {option.format === "mp4" && (
          <OptionRow label="fps">
            <Segmented
              aria-label="MP4 frame rate"
              options={MP4_RATES}
              value={mp4Rate}
              onChange={setMp4Rate}
            />
          </OptionRow>
        )}
        {animated && (
          <OptionRow label="pause">
            <Slider
              className="min-w-0 flex-1"
              aria-label="pause on the finished line"
              min={0}
              max={4000}
              step={500}
              value={holdMs}
              onValueChange={(value) => setHoldMs(value as number)}
            />
            <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {holdMs / 1000}s
            </span>
          </OptionRow>
        )}
      </div>
    );
  }

  function group(title: string, options: FormatOption[]) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="px-2 text-[11px] tracking-wide text-muted-foreground uppercase">
          {title}
        </span>
        <div className="flex flex-col gap-0.5 rounded-2xl bg-muted/50 p-1">
          {options.map((option) => {
            const unsupported = option.format === "mp4" && !canVideo;
            const active = option.format === format;
            const Icon = option.icon;
            return (
              // The card, not the row button, carries the selected look, so
              // the options panel unfolds inside the selection.
              <div
                key={option.format}
                className={cn(
                  "rounded-xl transition-all",
                  active && "bg-card shadow-sm dark:bg-muted",
                )}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={`export as ${option.label}`}
                  disabled={busy || unsupported}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-all",
                    "focus-visible:ring-2 focus-visible:ring-ring/50",
                    !active && "hover:bg-card/60 dark:hover:bg-muted/50",
                    (busy || unsupported) && "pointer-events-none opacity-50",
                  )}
                  onClick={() => setFormat(option.format)}
                >
                  <Icon
                    className={cn(
                      "size-4.5 shrink-0 transition-colors",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {unsupported ? "not supported in this browser" : option.description}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted-foreground">{option.extension}</span>
                </button>
                <Collapsible open={active}>
                  <CollapsibleContent>{optionsPanel(option)}</CollapsibleContent>
                </Collapsible>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <div className={chipSlotClass}>
        <DialogTrigger
          render={
            <Button
              variant="outline"
              className={chipRightClass}
              title="export"
              aria-label="export"
            />
          }
        >
          <DownloadIcon />
          <ChipLabel>export</ChipLabel>
        </DialogTrigger>
      </div>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>export</DialogTitle>
          <DialogDescription>save this take as a file, rendered in your browser</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="export format" className="flex flex-col gap-3">
          {group("still", STILL)}
          {group("animation", ANIMATED)}
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Button className="w-full rounded-full" onClick={download} disabled={busy}>
          {busy
            ? progress > 0
              ? `rendering… ${Math.round(progress * 100)}%`
              : "rendering…"
            : `download ${selected.extension}`}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
