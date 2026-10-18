import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/web/lib/utils";
import { Button } from "@/web/ui/button";

export type PageSection = {
  /** The anchor: `/profile#facts`. Links elsewhere in the app point at these, so keep them stable. */
  id: string;
  label: string;
  /** A short count or state after the label, like "29" or "Not set". */
  hint?: string | undefined;
  /** The hint asks for something, like "2 to review": it shows in the accent color. */
  attention?: boolean;
  content: ReactNode;
};

/** The top bar is 57px; this leaves breathing room under it when a section is scrolled to. */
const SCROLL_OFFSET = 57 + 24;

/**
 * The section in view: the last one whose top has passed a line a little under the top bar.
 * At the very bottom of the page it is the last section, even if that one is too short to reach
 * the line.
 */
function useSectionInView(ids: readonly string[]): string | undefined {
  const [current, setCurrent] = useState<string | undefined>(ids[0]);
  useEffect(() => {
    let frame = 0;
    function measure() {
      frame = 0;
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) {
        setCurrent(ids.at(-1));
        return;
      }
      let found = ids[0];
      for (const id of ids) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= SCROLL_OFFSET + 40) found = id;
      }
      setCurrent(found);
    }
    function onScroll() {
      if (!frame) frame = requestAnimationFrame(measure);
    }
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [ids]);
  return current;
}

/**
 * A long page of settings-like sections. On wide screens a list of the sections stays pinned on
 * the left and marks the one in view; on narrow screens the list is a row of links under the
 * title. Each section is a landmark named by its own heading, and keeps its anchor id.
 */
export function SectionPage({
  title,
  intro,
  sections,
}: {
  title: string;
  /** Anything between the title and the sections, like the setup checklist. */
  intro?: ReactNode;
  sections: readonly PageSection[];
}) {
  const [ids] = useState(() => sections.map((s) => s.id));
  const current = useSectionInView(ids);
  const list = useRef<HTMLUListElement>(null);

  // On a phone the list is a row that scrolls sideways; keep the current section's link in it.
  useEffect(() => {
    const row = list.current;
    const link = current ? row?.querySelector<HTMLElement>(`a[href="#${current}"]`) : null;
    if (!row || !link || row.scrollWidth <= row.clientWidth) return;
    const box = row.getBoundingClientRect();
    const tab = link.getBoundingClientRect();
    if (tab.left < box.left) row.scrollLeft += tab.left - box.left - 12;
    else if (tab.right > box.right) row.scrollLeft += tab.right - box.right + 12;
  }, [current]);

  function go(id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    // Instant: this is navigation the user asked for, often from the keyboard.
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET });
    // Move focus into the section so the keyboard and screen readers continue from there.
    target.focus({ preventScroll: true });
  }

  const links = sections.map((s) => (
    <li key={s.id}>
      <a
        href={`#${s.id}`}
        aria-current={current === s.id ? "location" : undefined}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          go(s.id);
        }}
        className={cn(
          "flex items-center justify-between gap-3 rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground pointer-coarse:min-h-11",
          "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-[current=location]:bg-muted aria-[current=location]:text-foreground",
          // On narrow screens the links sit in a row, so they size to their text.
          "max-lg:whitespace-nowrap",
        )}
      >
        <span className="truncate">{s.label}</span>
        {s.hint && (
          <span className={cn("shrink-0 text-xs tabular-nums", s.attention ? "text-primary" : "text-muted-foreground")}>
            {s.hint}
          </span>
        )}
      </a>
    </li>
  ));

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-8 lg:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6 lg:sticky lg:top-[calc(57px+1.5rem)] lg:self-start">
        <h1 className="display text-3xl">{title}</h1>
        <nav aria-label={`${title} sections`}>
          <ul ref={list} className="-mx-3 flex gap-1 overflow-x-auto pb-1 lg:grid lg:overflow-visible lg:pb-0">
            {links}
          </ul>
        </nav>
      </div>
      <div className="grid min-w-0 max-w-3xl content-start gap-10 lg:pt-1.5">
        {intro}
        {sections.map((s, i) => (
          <div
            key={s.id}
            id={s.id}
            // Focusable only from the section list, never in the Tab order.
            tabIndex={-1}
            className={cn("scroll-mt-20 focus:outline-none", i > 0 && "border-t pt-10")}
          >
            {s.content}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A section's heading and one-line description, the same on every section page. */
export function SectionHeading({
  id,
  title,
  description,
  action,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** A button on the heading's right, like "Add an add-on". */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="grid max-w-prose gap-1">
        <h2 id={id} className="font-semibold text-lg">
          {title}
        </h2>
        {description && <p className="text-pretty text-muted-foreground text-sm">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * A form's submit button, with a note when the fields differ from what is saved. The button stays
 * enabled either way: saving an unchanged form is harmless.
 */
export function SaveRow({
  dirty,
  pending,
  label,
  disabled,
  children,
}: {
  dirty: boolean;
  pending: boolean;
  label: string;
  disabled?: boolean;
  /** Anything after the note, like a validation message. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button type="submit" disabled={pending || disabled}>
        {pending ? "Saving…" : label}
      </Button>
      {dirty && !pending && (
        <span className="flex items-center gap-2 text-muted-foreground text-sm">
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          Unsaved changes
        </span>
      )}
      {children}
    </div>
  );
}
