import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
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
  return (
    <header className="sticky top-0 z-10 border-border/60 border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link to="/" className="font-semibold tracking-tight">
          Hanapbuhay
        </Link>
        <nav
          aria-label="Main"
          className="flex items-center gap-0.5 rounded-full border border-border/60 bg-card/50 p-1"
        >
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === "/" }}
              className="rounded-full border border-transparent px-3.5 py-1.5 text-muted-foreground text-sm transition-[color,background-color,border-color] duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[status=active]:border-border data-[status=active]:bg-secondary data-[status=active]:text-foreground data-[status=active]:shadow-[inset_0_1px_0_var(--sheen)]"
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
