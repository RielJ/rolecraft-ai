import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { AddJobDialog } from "./add-job-dialog";
import { RefreshButton } from "./refresh-button";

const NAV = [
  { to: "/matches", label: "Matches" },
  { to: "/board", label: "Board" },
  { to: "/profile", label: "Profile" },
  { to: "/sources", label: "Sources" },
  { to: "/settings", label: "Settings" },
] as const;

export function TopBar() {
  const [adding, setAdding] = useState(false);
  return (
    <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link to="/board" className="font-semibold tracking-tight">
          Hanapbuhay
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[status=active]:bg-secondary data-[status=active]:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <RefreshButton />
          <Button size="sm" onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden />
            Add job
          </Button>
        </div>
      </div>
      <AddJobDialog open={adding} onOpenChange={setAdding} />
    </header>
  );
}
