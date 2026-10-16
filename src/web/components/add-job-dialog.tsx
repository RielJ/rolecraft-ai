import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { PasteJobInput } from "@/shared/api";
import { errorMessage } from "../api";
import { useAddPastedJob } from "../queries";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

const EMPTY = { url: "", title: "", company: "", description: "" };

/** Paste a posting. Add by link arrives in slice 5; for now the link is kept as the apply URL. */
export function AddJobDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId();
  const navigate = useNavigate();
  const add = useAddPastedJob();
  const [form, setForm] = useState(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);

  const set = (field: keyof typeof EMPTY) => (value: string) => setForm((f) => ({ ...f, [field]: value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    const url = form.url.trim();
    const parsed = PasteJobInput.safeParse({ ...form, ...(url ? { url } : { url: undefined }) });
    if (!parsed.success) {
      setProblem(
        parsed.error.issues.some((i) => i.path[0] === "url")
          ? "The link must start with http:// or https://. Leave it empty if you have none."
          : "Title, company and description are all needed.",
      );
      return;
    }
    setProblem(null);
    add.mutate(parsed.data, {
      onSuccess: (result) => {
        if (result.kind === "existing") toast("This job is already on your board. Opened it.");
        setForm(EMPTY);
        onOpenChange(false);
        void navigate({ to: "/jobs/$opportunityId", params: { opportunityId: result.opportunityId } });
      },
      onError: (error) => setProblem(errorMessage(error)),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a job</DialogTitle>
          <DialogDescription>Paste the posting. It goes on your board as Saved.</DialogDescription>
        </DialogHeader>
        <form id={id} onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-url`}>Link to the posting (optional)</Label>
            <Input
              id={`${id}-url`}
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://"
              value={form.url}
              onChange={(e) => set("url")(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor={`${id}-title`}>Job title</Label>
              <Input id={`${id}-title`} value={form.title} onChange={(e) => set("title")(e.target.value)} autoFocus />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-company`}>Company</Label>
              <Input id={`${id}-company`} value={form.company} onChange={(e) => set("company")(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-description`}>Description</Label>
            <Textarea
              id={`${id}-description`}
              className="max-h-[40vh] min-h-40 font-serif"
              value={form.description}
              onChange={(e) => set("description")(e.target.value)}
            />
          </div>
          {problem && (
            <p role="alert" className="text-destructive text-sm">
              {problem}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={id} disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Add job"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
