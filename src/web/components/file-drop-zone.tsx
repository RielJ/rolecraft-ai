import { FileUp, LoaderCircle } from "lucide-react";
import { type DragEvent, type ReactNode, type Ref, useEffect, useState } from "react";
import { cn } from "@/web/lib/utils";

/** File-name extensions this zone takes, lower case with the dot, e.g. `[".pdf", ".docx"]`. */
type Extensions = readonly `.${string}`[];

function hasFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

/**
 * Why a dropped or chosen set of files cannot be read, or null when it holds exactly one file
 * with an accepted extension.
 */
export function fileProblem(files: FileList | readonly File[], extensions: Extensions, kinds: string): string | null {
  if (files.length === 0) return null;
  if (files.length > 1) return `Drop one file at a time: a ${kinds}.`;
  const name = files[0]?.name.toLowerCase() ?? "";
  return extensions.some((ext) => name.endsWith(ext)) ? null : `That file is not a ${kinds}. Choose a ${kinds}.`;
}

/**
 * A large target that takes a file by drag and drop or by click. The file input stays in the
 * page (visually hidden), so Tab reaches it and Enter or Space opens the picker.
 */
export function FileDropZone({
  id,
  inputRef,
  accept,
  extensions,
  kinds,
  title,
  busy,
  busyLabel,
  disabled,
  footer,
  onFile,
  onReject,
}: {
  id: string;
  inputRef?: Ref<HTMLInputElement>;
  /** The input's `accept`: extensions and MIME types. */
  accept: string;
  /** What a dropped file's name must end with. Drops skip `accept`, so this checks them. */
  extensions: Extensions;
  /** The accepted kinds in words, e.g. "PDF or DOCX". */
  kinds: string;
  title: string;
  busy: boolean;
  busyLabel: string;
  disabled: boolean;
  /** A line under the hint, e.g. which file was read last. It may hold a button or a link. */
  footer?: ReactNode;
  onFile: (file: File) => void;
  onReject: (problem: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const off = disabled || busy;

  // A file dropped just outside the zone would make the browser open it and leave the app.
  useEffect(() => {
    const swallow = (event: globalThis.DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  function take(files: FileList | null) {
    if (!files || files.length === 0) return;
    const problem = fileProblem(files, extensions, kinds);
    const file = files[0];
    if (problem) onReject(problem);
    else if (file) onFile(file);
  }

  function over(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = off ? "none" : "copy";
    if (!off) setDragging(true);
  }

  // The zone is a div so the footer can hold a button: a button inside a label is invalid HTML.
  // The label's ::after covers the whole zone, so a click anywhere but the footer's own controls
  // opens the picker, as before.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop is a pointer extra; the file input inside is the keyboard path.
    <div
      data-slot="file-drop-zone"
      data-dragging={dragging || undefined}
      data-disabled={off || undefined}
      onDragEnter={over}
      onDragOver={over}
      onDragLeave={(event) => {
        // Leaving for a child (the icon, a line of text) is still inside the zone.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!off) take(event.dataTransfer.files);
      }}
      className={cn(
        "relative flex min-h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-input border-dashed px-6 py-8 text-center",
        "transition-[background-color,border-color] duration-150 ease-out",
        "hover:border-ring/60 hover:bg-accent/40",
        "has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-[3px] has-[input:focus-visible]:ring-ring/50",
        "data-dragging:border-primary data-dragging:bg-primary/10",
        "data-disabled:cursor-not-allowed data-disabled:hover:border-input data-disabled:hover:bg-transparent",
      )}
    >
      <label htmlFor={id} className="flex flex-col items-center gap-2 after:absolute after:inset-0 after:rounded-lg">
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          disabled={off}
          aria-label={`${title} (${kinds})`}
          className="sr-only"
          onChange={(event) => take(event.target.files)}
        />
        {busy ? (
          <LoaderCircle aria-hidden className="size-7 text-muted-foreground motion-safe:animate-spin" />
        ) : (
          <FileUp aria-hidden className={cn("size-7", dragging ? "text-primary" : "text-muted-foreground")} />
        )}
        <span className="font-medium text-base" aria-live="polite">
          {busy ? busyLabel : dragging ? "Drop it to upload" : title}
        </span>
        {!busy && (
          <span className="text-muted-foreground text-sm">
            Drag a {kinds} here, or <span className="text-foreground underline underline-offset-4">choose a file</span>
          </span>
        )}
      </label>
      {footer && !busy && (
        // Above the label's cover, but clicks on plain text still fall through to it.
        <span className="pointer-events-none relative z-10 text-muted-foreground text-xs [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
          {footer}
        </span>
      )}
    </div>
  );
}
