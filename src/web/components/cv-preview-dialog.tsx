import { type RefObject, useId, useState } from "react";
import type { FactDto, ProfileDto, ProfileItemDto } from "@/shared/api";
import { panelId, type Tab, TabList, tabId } from "@/web/components/tab-list";
import { useMediaQuery } from "@/web/lib/use-media-query";
import { cn } from "@/web/lib/utils";
import { Badge } from "@/web/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/web/ui/dialog";

type CvTab = "pdf" | "text" | "facts";

/** Why there is no PDF to show, by the kind of file the CV was read from (decision 69). */
function noFileHint(fileName: string | null): string | null {
  const name = fileName?.toLowerCase() ?? "";
  if (name.endsWith(".docx")) return "Word files show as the text the AI read.";
  // No stored row can't tell an old upload from one over 5 MB, so the hint covers both.
  if (name.endsWith(".pdf"))
    return "No copy of this PDF is kept: it was read before copies were kept, or it is over 5 MB. Upload it again to see it here.";
  return null;
}

const sizeLabel = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function CvFacts({ facts }: { facts: FactDto[] }) {
  if (facts.length === 0) {
    return <p className="text-muted-foreground text-sm">No facts from this CV yet.</p>;
  }
  return (
    <ul className="divide-y" aria-label="Facts from this CV">
      {facts.map((f) => (
        <li key={f.id} className="grid gap-1 py-2.5 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className="font-mono tabular-nums">{f.key}</span>
            {f.status === "pending" && <Badge variant="outline">To review</Badge>}
          </span>
          <span className="text-pretty">{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The CV as uploaded beside the text read from it (decision 69). The PDF tab shows the kept file
 * in the browser's own viewer; the Text tab shows what was split into facts. From 1024 px the CV's
 * facts sit beside the tabs; narrower, they get a tab of their own.
 */
export function CvPreviewDialog({
  cv,
  cvFile,
  facts,
  open,
  onOpenChange,
  returnFocus,
}: {
  cv: ProfileItemDto;
  cvFile: ProfileDto["cvFile"];
  facts: FactDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opened it. With no DialogTrigger, Radix would leave focus on the body. */
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const prefix = `${useId()}-`;
  const wide = useMediaQuery("(min-width: 64rem)");
  const [picked, setPicked] = useState<CvTab>(cvFile ? "pdf" : "text");
  const cvFacts = facts.filter((f) => f.itemKind === "cv" && f.inLatest);
  const tabs: Tab<CvTab>[] = [
    ...(cvFile ? [{ value: "pdf" as const, label: "PDF" }] : []),
    { value: "text", label: "Text" },
    ...(wide ? [] : [{ value: "facts" as const, label: `Facts (${cvFacts.length})` }]),
  ];
  // Widening the window while on Facts moves the facts beside the tabs; show the first tab then.
  const tab = tabs.some((t) => t.value === picked) ? picked : (tabs[0]?.value ?? "text");
  const hint = cvFile ? null : noFileHint(cv.fileName);
  const description = cvFile
    ? `${cvFile.fileName}, ${sizeLabel(cvFile.size)}: the PDF as uploaded, and the text read from it.`
    : cv.fileName
      ? `The text read from ${cv.fileName}.`
      : "The text you pasted.";
  const panel = (value: CvTab, className?: string) => ({
    role: "tabpanel",
    id: panelId(value, prefix),
    "aria-labelledby": tabId(value, prefix),
    hidden: tab !== value,
    className: cn("min-h-0 flex-1", className),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
        className="flex h-[min(56rem,calc(100dvh-2rem))] flex-col gap-4 sm:max-w-[min(76rem,calc(100%-2rem))]"
      >
        <DialogHeader>
          <DialogTitle>Your CV</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-h-0 flex-col gap-3">
            <TabList
              label="Show the CV as"
              variant="pill"
              tabs={tabs}
              value={tab}
              onChange={setPicked}
              idPrefix={prefix}
            />
            {cvFile && (
              <div {...panel("pdf")}>
                <iframe
                  title={`Your CV as uploaded: ${cvFile.fileName}`}
                  src={`/api/profile/cv/file?v=${encodeURIComponent(cvFile.uploadedAt)}`}
                  className="size-full rounded-md border bg-muted/30"
                />
              </div>
            )}
            <div {...panel("text", "flex flex-col gap-3")}>
              {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-4 font-serif text-sm leading-relaxed">
                {cv.body}
              </pre>
            </div>
            {!wide && (
              <div {...panel("facts", "overflow-auto")}>
                <CvFacts facts={cvFacts} />
              </div>
            )}
          </div>
          {wide && (
            <aside aria-labelledby={`${prefix}facts-h`} className="flex min-h-0 flex-col gap-2">
              <h3 id={`${prefix}facts-h`} className="font-medium text-sm">
                Facts from this CV <span className="text-muted-foreground tabular-nums">{cvFacts.length}</span>
              </h3>
              <div className="min-h-0 flex-1 overflow-auto border-t">
                <CvFacts facts={cvFacts} />
              </div>
            </aside>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
