import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import type { SettingsDto } from "@/shared/api";
import { AI_PROVIDERS, type AiProvider } from "@/shared/enums";
import { errorMessage } from "../api";
import { useRemoveAiKey, useSaveAiKey, useSettings, useUpdateSettings } from "../queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";

const onError = (error: unknown) => toast.error(errorMessage(error));

const PROVIDERS: Record<AiProvider, { name: string; hint: string; keysUrl: string; keysHost: string }> = {
  anthropic: {
    name: "Anthropic",
    hint: "Keys start with sk-ant-",
    keysUrl: "https://console.anthropic.com/settings/keys",
    keysHost: "console.anthropic.com",
  },
  openai: {
    name: "OpenAI",
    hint: "Keys start with sk-",
    keysUrl: "https://platform.openai.com/api-keys",
    keysHost: "platform.openai.com",
  },
};

const isProvider = (value: string): value is AiProvider => AI_PROVIDERS.some((p) => p === value);

const usd = (n: number) => `$${n.toFixed(2)}`;

function KeyForm({ ai }: { ai: SettingsDto["ai"] }) {
  const id = useId();
  const save = useSaveAiKey();
  const remove = useRemoveAiKey();
  const [provider, setProvider] = useState<AiProvider>(ai.provider ?? "anthropic");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const info = PROVIDERS[provider];

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!key.trim()) return;
    setError(null);
    save.mutate(
      { provider, key: key.trim() },
      {
        onSuccess: () => {
          setKey("");
          toast(`${info.name} key saved. Drafting is on.`);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-4" aria-labelledby={`${id}-h`}>
      <div>
        <h2 id={`${id}-h`} className="font-semibold text-lg">
          AI key
        </h2>
        <p className="text-muted-foreground text-sm">
          Drafting uses your own key. It is stored in a file only this app can read, never in the database, and it is
          never shown again.
        </p>
      </div>
      {ai.provider && ai.keyHint && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span>
            Using {PROVIDERS[ai.provider].name} with the key ending{" "}
            <span className="font-mono tabular-nums">…{ai.keyHint}</span>
          </span>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0 text-destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate(undefined, { onSuccess: () => toast("Key removed."), onError })}
          >
            Remove key
          </Button>
        </p>
      )}
      <fieldset className="grid gap-2">
        <legend className="mb-2 font-medium text-sm">Provider</legend>
        <RadioGroup
          value={provider}
          onValueChange={(value) => {
            if (isProvider(value)) setProvider(value);
          }}
          className="flex gap-6"
        >
          {AI_PROVIDERS.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <RadioGroupItem value={p} id={`${id}-${p}`} />
              <Label htmlFor={`${id}-${p}`} className="font-normal">
                {PROVIDERS[p].name}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </fieldset>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-key`}>{ai.keyHint ? "Replace the API key" : "API key"}</Label>
        <Input
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setError(null);
          }}
          aria-invalid={error !== null}
          aria-describedby={`${id}-key-help`}
          className="font-mono"
        />
        <p id={`${id}-key-help`} className={error ? "text-destructive text-sm" : "text-muted-foreground text-sm"}>
          {error ?? (
            <>
              {info.hint}. Create one at{" "}
              <a href={info.keysUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                {info.keysHost}
              </a>
              .
            </>
          )}
        </p>
      </div>
      <Button type="submit" className="justify-self-start" disabled={save.isPending || !key.trim()}>
        {save.isPending ? "Checking key…" : "Save key"}
      </Button>
    </form>
  );
}

function ModelsForm({ ai }: { ai: SettingsDto["ai"] }) {
  const id = useId();
  const update = useUpdateSettings();
  const [light, setLight] = useState(ai.modelLight ?? "");
  const [writing, setWriting] = useState(ai.modelWriting ?? "");
  const defaults = ai.defaults[ai.provider ?? "anthropic"];

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate(
      { modelLight: light.trim(), modelWriting: writing.trim() },
      { onSuccess: () => toast("Models saved."), onError },
    );
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-4" aria-labelledby={`${id}-h`}>
      <div>
        <h2 id={`${id}-h`} className="font-semibold text-lg">
          Models
        </h2>
        <p className="text-muted-foreground text-sm">
          Leave a field empty to use the default. The writing model drafts files; the light model reads postings and
          splits your CV.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-writing`}>Writing model</Label>
          <Input
            id={`${id}-writing`}
            className="font-mono"
            spellCheck={false}
            value={writing}
            placeholder={defaults.writing}
            onChange={(e) => setWriting(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-light`}>Light model</Label>
          <Input
            id={`${id}-light`}
            className="font-mono"
            spellCheck={false}
            value={light}
            placeholder={defaults.light}
            onChange={(e) => setLight(e.target.value)}
          />
        </div>
      </div>
      <Button type="submit" variant="secondary" className="justify-self-start" disabled={update.isPending}>
        {update.isPending ? "Saving…" : "Save models"}
      </Button>
    </form>
  );
}

function SpendForm({ settings }: { settings: SettingsDto }) {
  const id = useId();
  const update = useUpdateSettings();
  const { spend, ai } = settings;
  const [cap, setCap] = useState(ai.monthlyCapUsd === null ? "" : String(ai.monthlyCapUsd));
  const parsed = cap.trim() === "" ? null : Number(cap);
  const invalid = parsed !== null && !(Number.isFinite(parsed) && parsed > 0);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    update.mutate(
      { monthlyCapUsd: parsed },
      { onSuccess: () => toast(parsed === null ? "Cap removed." : `Cap set to ${usd(parsed)} a month.`), onError },
    );
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-4" aria-labelledby={`${id}-h`}>
      <div>
        <h2 id={`${id}-h`} className="font-semibold text-lg">
          Spend
        </h2>
        <p className="text-muted-foreground text-sm">Costs are in USD, counted by Manila calendar month.</p>
      </div>
      <p>
        <span className="font-semibold text-2xl tabular-nums">{usd(spend.monthUsd)}</span>{" "}
        <span className="text-muted-foreground">this month</span>
        <span className="block text-muted-foreground text-sm tabular-nums">
          {spend.calls} AI call{spend.calls === 1 ? "" : "s"}
          {spend.unpricedCalls > 0 &&
            `, ${spend.unpricedCalls} on a model with no known price (not counted in the total)`}
        </span>
      </p>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-cap`}>Monthly cap in USD</Label>
        <div className="flex max-w-xs gap-2">
          <Input
            id={`${id}-cap`}
            inputMode="decimal"
            className="tabular-nums"
            value={cap}
            placeholder="No cap"
            aria-invalid={invalid}
            aria-describedby={`${id}-cap-help`}
            onChange={(e) => setCap(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={update.isPending || invalid}>
            Save cap
          </Button>
        </div>
        <p id={`${id}-cap-help`} className={invalid ? "text-destructive text-sm" : "text-muted-foreground text-sm"}>
          {invalid
            ? "Enter an amount above zero, like 5 or 12.50, or leave it empty for no cap."
            : "Before a call would cross the cap, the app asks you first."}
        </p>
      </div>
    </form>
  );
}

function EligibilityToggle({ ai }: { ai: SettingsDto["ai"] }) {
  const id = useId();
  const update = useUpdateSettings();
  return (
    <div className="flex max-w-2xl items-start gap-3">
      <Switch
        id={id}
        className="mt-0.5"
        checked={ai.eligibilityOnRefresh}
        disabled={update.isPending}
        onCheckedChange={(checked) => update.mutate({ eligibilityOnRefresh: checked }, { onError })}
        aria-describedby={`${id}-help`}
      />
      <div className="grid gap-1">
        <Label htmlFor={id}>Check eligibility with AI on Refresh</Label>
        <p id={`${id}-help`} className="text-muted-foreground text-sm">
          Reads postings the rules cannot place. Uses the light model and adds to your spend.
        </p>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  if (settings.isPending) return <p className="text-muted-foreground">Loading settings…</p>;
  if (settings.isError) {
    return (
      <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 p-4 text-sm">
        <span>Could not load settings. {errorMessage(settings.error)}</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => settings.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const { ai } = settings.data;
  return (
    <div className="grid gap-10">
      <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
      <KeyForm ai={ai} />
      <Separator />
      <SpendForm key={String(ai.monthlyCapUsd)} settings={settings.data} />
      <Separator />
      <ModelsForm key={`${ai.provider}:${ai.modelLight}:${ai.modelWriting}`} ai={ai} />
      <EligibilityToggle ai={ai} />
    </div>
  );
}
