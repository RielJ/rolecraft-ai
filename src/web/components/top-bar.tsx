import { Link, useRouterState } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "../ui/button";
import { AddJobDialog } from "./add-job-dialog";
import { RefreshButton } from "./refresh-button";

const NAV = [
  { to: "/", label: "Matches" },
  { to: "/board", label: "Board" },
  { to: "/profile", label: "Profile" },
  { to: "/sources", label: "Sources" },
  { to: "/settings", label: "Settings" },
] as const;

// The Add job dialog lives in the top bar; screens open it with their own key (`a` on Matches).
// A dialog a key opened opens and closes with no motion (section 4).
type AddJobState = "closed" | "key" | "click";
let addingJob: AddJobState = "closed";
const addJobListeners = new Set<() => void>();

export function setAddJobOpen(open: boolean, via: "key" | "click" = "click"): void {
  addingJob = open ? via : "closed";
  for (const listener of addJobListeners) listener();
}

function subscribeAddJob(listener: () => void) {
  addJobListeners.add(listener);
  return () => addJobListeners.delete(listener);
}

export function TopBar() {
  const adding = useSyncExternalStore(subscribeAddJob, () => addingJob);
  const nav = useRef<HTMLElement>(null);
  const path = useRouterState({ select: (s) => s.location.pathname });
  // On a phone the tabs scroll sideways; keep the current one in view.
  useEffect(() => {
    if (!path) return;
    const active = nav.current?.querySelector<HTMLElement>("[data-status=active]");
    if (active && nav.current) {
      const box = nav.current.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      nav.current.scrollLeft += tab.left - box.left - (box.width - tab.width) / 2;
    }
  }, [path]);
  return (
    <header className="sticky top-0 z-10 border-border/60 border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
      {/* One 57px row on wide screens (pinned headers below rely on it); narrower, the tabs wrap to a second row. */}
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 sm:px-6 lg:h-14 lg:flex-nowrap lg:py-0">
        <Link to="/" className="font-semibold tracking-tight">
          Hanapbuhay
        </Link>
        <nav
          ref={nav}
          aria-label="Main"
          className="order-last flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border/60 bg-card/50 p-1 [scrollbar-width:none] lg:order-none"
        >
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === "/" }}
              className="shrink-0 rounded-full border border-transparent px-3.5 py-1.5 text-muted-foreground text-sm transition-[color,background-color,border-color] duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[status=active]:border-border data-[status=active]:bg-secondary data-[status=active]:text-foreground data-[status=active]:shadow-[inset_0_1px_0_var(--sheen)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <RefreshButton />
          <Button size="sm" onClick={() => setAddJobOpen(true)}>
            <PlusIcon aria-hidden />
            Add job
          </Button>
        </div>
      </div>
      <AddJobDialog
        open={adding !== "closed"}
        instant={adding === "key"}
        onOpenChange={(open) => setAddJobOpen(open)}
      />
    </header>
  );
}
