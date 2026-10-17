import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Kbd } from "../ui/kbd";

/** The Matches keyboard model, worded as in PLAN.md section 4. */
const SHORTCUTS: readonly { keys: readonly (readonly string[])[]; action: string }[] = [
  { keys: [["j"], ["↓"]], action: "Next job" },
  { keys: [["k"], ["↑"]], action: "Previous job" },
  { keys: [["Home"], ["End"]], action: "First or last job" },
  { keys: [["Space"], ["Shift", "Space"]], action: "Scroll the reading pane" },
  { keys: [["Enter"], ["o"]], action: "Open the workspace (saves to the board as Saved)" },
  { keys: [["s"]], action: "Save to the board and move to the next job" },
  { keys: [["d"]], action: "Dismiss: 1 wrong stack, 2 too senior, 3 pay, 4 location, 5 other, Enter without a reason" },
  { keys: [["z"]], action: "Undo the last save or dismiss" },
  { keys: [["v"]], action: "Open the posting in a new tab" },
  { keys: [["/"]], action: "Focus search; Esc returns to the list" },
  { keys: [["e"]], action: "Show or hide excluded jobs" },
  { keys: [["a"]], action: "Add a job by link" },
  { keys: [["?"]], action: "Shortcut sheet" },
];

export function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Keys are ignored while focus is in a text field.</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-2 text-sm">
          {SHORTCUTS.map(({ keys, action }) => (
            <div key={action} className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-3">
              <dt className="flex flex-wrap items-center gap-1">
                {keys.map((combo, i) => (
                  <span key={combo.join("+")} className="inline-flex items-center gap-1">
                    {i > 0 && <span className="text-muted-foreground text-xs">or</span>}
                    {combo.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                ))}
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
