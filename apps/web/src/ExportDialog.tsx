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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ChipLabel, chipRightClass, chipSlotClass, useCloseOnHashNavigate } from "./controls.js";
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
  type ExportStyle,
} from "./export.js";

/**
 * The export dialog: five formats in two groups (still and animation),
 * picked from a radio list and saved with one button. Everything renders
 * client-side; the slow encodes (GIF, MP4) stream progress into the
 * download button and abort if the dialog closes.
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

interface ExportDialogProps {
  text: string;
  getOffsets: () => ReadonlyArray<[number, number, number]>;
  getStyle: () => ExportStyle;
}

export default function ExportDialog({ text, getOffsets, getStyle }: ExportDialogProps) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("png");
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
      const onProgress = (done: number, total: number) => setProgress(done / total);
      let blob: Blob;
      switch (format) {
        case "svg":
          blob = toStaticSvg(offsets, style);
          break;
        case "animated-svg":
          blob = toAnimatedSvg(offsets, style);
          break;
        case "png":
          blob = await toPng(offsets, style);
          break;
        case "gif":
          blob = await toGif(offsets, style, onProgress, controller.signal);
          break;
        case "mp4":
          blob = await toMp4(offsets, style, onProgress, controller.signal);
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
              <button
                key={option.format}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`export as ${option.label}`}
                disabled={busy || unsupported}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-all",
                  "focus-visible:ring-2 focus-visible:ring-ring/50",
                  active ? "bg-card shadow-sm dark:bg-muted" : "hover:bg-card/60 dark:hover:bg-muted/50",
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
          <DialogDescription>save this take as a file — all made in your browser</DialogDescription>
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
