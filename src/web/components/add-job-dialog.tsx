import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { type AddJobResult, AddLinkInput, type AddLinkResult, PasteJobInput } from "@/shared/api";
import { blockedSite } from "@/shared/hosts";
import { errorMessage } from "../api";
import { useAddJobFromLink, useAddPastedJob } from "../queries";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

const EMPTY = { url: "", title: "", company: "", description: "" };
type Form = typeof EMPTY;
type Mode = "link" | "paste";

/** Why the paste form opened instead of a job (section 4, Add job: error). */
function pasteReason(result: Extract<AddLinkResult, { kind: "needs_paste" }>): string {
  switch (result.reason) {
    case "blocked_host":
      return `${blockedSite(result.url) ?? "This site"} does not allow automated reading. Paste the description.`;
    case "too_little_text":
      return "The page had too little text to read. Paste the description.";
    case "fetch_failed":
      return "The page could not be read. Check the link, or paste the description.";
  }
}

/**
 * Add a job by link (section 3.2), or paste it. A link the server cannot read becomes the paste
 * form with the link kept as the apply URL and whatever was found filled in.
 */
export function AddJobDialog({
  open,
  instant = false,
  onOpenChange,
}: {
  open: boolean;
  /** Opened by a key: no motion. */
  instant?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const navigate = useNavigate();
  const fromLink = useAddJobFromLink();
  const fromPaste = useAddPastedJob();
  const [mode, setMode] = useState<Mode>("link");
  const [form, setForm] = useState<Form>(EMPTY);
  const [reason, setReason] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = fromLink.isPending || fromPaste.isPending;

  const set = (field: keyof Form) => (value: string) => setForm((f) => ({ ...f, [field]: value }));

  function reset() {
    setMode("link");
    setForm(EMPTY);
    setReason(null);
    setProblem(null);
  }

  function close(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function opened(result: AddJobResult) {
    if (result.kind === "existing") toast("This job is already on your board. Opened it.");
    close(false);
    void navigate({ to: "/jobs/$opportunityId", params: { opportunityId: result.opportunityId } });
  }

  function switchTo(next: Mode) {
    setMode(next);
    setReason(null);
    setProblem(null);
  }

  function submitLink() {
    const parsed = AddLinkInput.safeParse({ url: form.url.trim() });
    if (!parsed.success) {
      setProblem("The link must start with http:// or https://.");
      return;
    }
    setProblem(null);
    fromLink.mutate(parsed.data, {
      onSuccess: (result) => {
        if (result.kind !== "needs_paste") return opened(result);
        setForm((f) => ({
          ...f,
          url: result.url,
          title: f.title || result.prefill.title || "",
          company: f.company || result.prefill.company || "",
        }));
        setMode("paste");
        setReason(pasteReason(result));
      },
      onError: (error) => setProblem(errorMessage(error)),
    });
  }

  function submitPaste() {
    const url = form.url.trim();
    const parsed = PasteJobInput.safeParse({ ...form, url: url || undefined });
    if (!parsed.success) {
      setProblem(
        parsed.error.issues.some((i) => i.path[0] === "url")
          ? "The link must start with http:// or https://. Leave it empty if you have none."
          : "Title, company and description are all needed.",
      );
      return;
    }
    setProblem(null);
    fromPaste.mutate(parsed.data, { onSuccess: opened, onError: (error) => setProblem(errorMessage(error)) });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (mode === "link") submitLink();
    else submitPaste();
  }

  // After a link falls back, the first empty field is where the user types next.
  const pasteFocus = !form.title ? "title" : !form.company ? "company" : "description";

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent instant={instant} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a job</DialogTitle>
          <DialogDescription>
            {mode === "link"
              ? "Paste the link to the posting. The app reads the page once and puts the job on your board as Saved."
              : "Paste the posting. It goes on your board as Saved."}
          </DialogDescription>
        </DialogHeader>
        <form id={id} onSubmit={submit} className="grid gap-4">
          {reason && (
            <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
              {reason}
            </p>
          )}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-url`}>
              {mode === "link" ? "Link to the posting" : "Link to the posting (optional)"}
            </Label>
            <Input
              id={`${id}-url`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://"
              value={form.url}
              readOnly={fromLink.isPending}
              onChange={(e) => set("url")(e.target.value)}
              autoFocus={mode === "link"}
            />
          </div>
          {mode === "paste" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor={`${id}-title`}>Job title</Label>
                  <Input
                    id={`${id}-title`}
                    value={form.title}
                    onChange={(e) => set("title")(e.target.value)}
                    autoFocus={pasteFocus === "title"}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={`${id}-company`}>Company</Label>
                  <Input
                    id={`${id}-company`}
                    value={form.company}
                    onChange={(e) => set("company")(e.target.value)}
                    autoFocus={pasteFocus === "company"}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`${id}-description`}>Description</Label>
                <Textarea
                  id={`${id}-description`}
                  className="max-h-[40vh] min-h-40 font-serif"
                  value={form.description}
                  onChange={(e) => set("description")(e.target.value)}
                  autoFocus={pasteFocus === "description"}
                />
              </div>
            </>
          )}
          {fromLink.isPending && (
            <p role="status" className="text-muted-foreground text-sm">
              Reading the page…
            </p>
          )}
          {problem && (
            <p role="alert" className="text-destructive text-sm">
              {problem}
            </p>
          )}
        </form>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="link"
            className="px-0"
            disabled={pending}
            onClick={() => switchTo(mode === "link" ? "paste" : "link")}
          >
            {mode === "link" ? "Paste instead" : "Add by link instead"}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" form={id} disabled={pending}>
              {fromLink.isPending ? "Reading…" : fromPaste.isPending ? "Adding…" : "Add job"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
