import { KeyRoundIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { CurrencyCode, type FxRateBy, isValidCap, MIN_CAP_USD, type SettingsDto } from "@/shared/api";
import { AI_PROVIDERS, type AiProvider } from "@/shared/enums";
import { fillRatesSummary, fxAgeLines, fxProvenanceLabel, rateDayLabel } from "@/shared/labels";
import { errorMessage } from "../api";
import { ExtensionPairing } from "../components/extension-pairing";
import { type PageSection, SectionHeading, SectionPage } from "../components/section-page";
import { cn } from "../lib/utils";
import { useFillRates, useRemoveAiKey, useSaveAiKey, useSettings, useUpdateSettings } from "../queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
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
    <form onSubmit={submit} className="grid gap-5" aria-labelledby={`${id}-h`}>
      <SectionHeading
        id={`${id}-h`}
        title="AI key"
        description="Drafting uses your own key. It is stored in a file only this app can read, never in the database, and it is never shown again."
      />
      {ai.provider && ai.keyHint && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <KeyRoundIcon aria-hidden className="size-4 text-muted-foreground" />
          <span>
            Using {PROVIDERS[ai.provider].name} with the key ending{" "}
            <span className="font-mono tabular-nums">…{ai.keyHint}</span>
          </span>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="ml-2 h-auto px-0 text-destructive"
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
      <div className="grid max-w-md gap-2">
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
    <form onSubmit={submit} className="grid gap-4" aria-labelledby={`${id}-h`}>
      <div className="grid gap-1">
        <h3 id={`${id}-h`} className="font-medium text-sm">
          Models
        </h3>
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
  const invalid = parsed !== null && !(Number.isFinite(parsed) && isValidCap(parsed));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    update.mutate(
      { monthlyCapUsd: parsed },
      { onSuccess: () => toast(parsed === null ? "Cap removed." : `Cap set to ${usd(parsed)} a month.`), onError },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-5" aria-labelledby={`${id}-h`}>
      <SectionHeading id={`${id}-h`} title="Spend" description="Costs are in USD, counted by Manila calendar month." />
      <SpendMeter spend={spend} cap={ai.monthlyCapUsd} />
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
            ? `Enter an amount of at least ${usd(MIN_CAP_USD)}, like 5 or 12.50, or leave it empty for no cap.`
            : "Before a call would cross the cap, the app asks you first."}
        </p>
      </div>
    </form>
  );
}

/** This month's spend, and how much of the cap it has used when there is one. */
/** This month's spend as one line, with how much of the cap it has used when there is one. */
function SpendMeter({ spend, cap }: { spend: SettingsDto["spend"]; cap: number | null }) {
  const used = cap ? Math.min(spend.monthUsd / cap, 1) : 0;
  const near = used >= 0.8;
  return (
    <div className="grid max-w-md gap-2.5">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-semibold text-2xl tabular-nums tracking-tight">{usd(spend.monthUsd)}</span>
        <span className="text-muted-foreground text-sm tabular-nums">
          {cap ? `of ${usd(cap)} this month` : "this month"} · {spend.calls} AI call{spend.calls === 1 ? "" : "s"}
        </span>
      </p>
      {cap !== null && (
        <>
          <meter className="sr-only" aria-label="Share of the monthly cap used" min={0} max={1} value={used} />
          <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
            {/* scaleX, not width: the bar changes without a layout pass. */}
            <div
              className={cn(
                "h-full origin-left rounded-full transition-transform duration-300 ease-out",
                near ? "bg-destructive" : "bg-primary",
              )}
              style={{ transform: `scaleX(${used > 0 ? Math.max(used, 0.02) : 0})` }}
            />
          </div>
        </>
      )}
      {spend.unpricedCalls > 0 && (
        <p className="text-muted-foreground text-sm tabular-nums">
          {spend.unpricedCalls} call{spend.unpricedCalls === 1 ? " was" : "s were"} on a model with no known price, so
          {spend.unpricedCalls === 1 ? " it is" : " they are"} not in the total.
        </p>
      )}
    </div>
  );
}

function EligibilityToggle({ ai }: { ai: SettingsDto["ai"] }) {
  const id = useId();
  const update = useUpdateSettings();
  return (
    <div className="flex items-start gap-3">
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

type Money = SettingsDto["money"];

const SET_ON = new Intl.DateTimeFormat("en-PH", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "Asia/Manila",
});

/** A positive rate typed by hand, or null when the text is not one. */
function rateFrom(text: string): number | null {
  const n = Number(text.replace(/,/g, "").trim());
  return text.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

function ViewCurrencyForm({ money, onFill }: { money: Money; onFill: () => void }) {
  const id = useId();
  const update = useUpdateSettings();
  const [code, setCode] = useState(money.viewCurrency);
  const parsed = CurrencyCode.safeParse(code);
  const changed = parsed.success && parsed.data !== money.viewCurrency;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!parsed.success || !changed) return;
    update.mutate(
      { viewCurrency: parsed.data },
      {
        // Changing the view currency never fetches (decision 67); the toast offers it.
        onSuccess: () =>
          toast(
            money.fxRates.length
              ? `Pay now shows in ${parsed.data}. Your rates were cleared.`
              : `Pay now shows in ${parsed.data}.`,
            { action: { label: "Fill rates", onClick: onFill } },
          ),
        onError,
      },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-2">
      <Label htmlFor={`${id}-code`}>View currency</Label>
      <div className="flex max-w-xs gap-2">
        <Input
          id={`${id}-code`}
          className="w-24 uppercase"
          maxLength={3}
          autoComplete="off"
          spellCheck={false}
          value={code}
          aria-invalid={!parsed.success}
          aria-describedby={`${id}-help`}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <Button type="submit" variant="secondary" disabled={update.isPending || !changed}>
          Save currency
        </Button>
      </div>
      <p
        id={`${id}-help`}
        className={cn("max-w-prose text-sm", parsed.success ? "text-muted-foreground" : "text-destructive")}
      >
        {parsed.success
          ? "Pay shows as a monthly amount in this currency. Changing it clears your rates, since they are relative to it."
          : "Use a three-letter currency code, such as PHP or USD."}
      </p>
    </form>
  );
}

/** What a rate row says under its source: who set it and when, or why it has none. */
function rateNote({ entry, unsupported }: { entry: RateEntry | undefined; unsupported: boolean }): string | null {
  if (entry === undefined) return unsupported ? "No source publishes this rate. Type it in." : null;
  if (entry.by === "user")
    return `Set by you ${SET_ON.format(new Date(entry.setAt))}. Remove it to update it automatically.`;
  const day = entry.rateDate === null ? "" : `, rate of ${rateDayLabel(entry.rateDate)}`;
  return `${fxProvenanceLabel(entry.by)}${day}`;
}

type RateEntry = { rate: number; setAt: string; by: FxRateBy; rateDate: string | null };

/** One currency's rate: set, changed or removed. A currency with no rate yet shows an empty field. */
function RateRow({
  money,
  currency,
  entry,
  unsupported = false,
}: {
  money: Money;
  currency: string;
  entry?: RateEntry;
  unsupported?: boolean;
}) {
  const rate = entry?.rate;
  const id = useId();
  const update = useUpdateSettings();
  const [text, setText] = useState(rate === undefined ? "" : String(rate));
  const value = rateFrom(text);
  const invalid = text.trim() !== "" && value === null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value === null || value === rate) return;
    update.mutate(
      { fxRates: { [currency]: value } },
      { onSuccess: () => toast(`1 ${currency} = ${value} ${money.viewCurrency}`), onError },
    );
  }

  const changed = value !== null && value !== rate;

  return (
    <li>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
        <Label htmlFor={`${id}-rate`} className="w-16 font-normal tabular-nums">
          1 {currency}
        </Label>
        <div className="relative">
          <Input
            id={`${id}-rate`}
            inputMode="decimal"
            className="h-8 w-36 pr-12 tabular-nums"
            placeholder="Rate"
            value={text}
            aria-invalid={invalid}
            aria-describedby={`${id}-note`}
            onChange={(e) => setText(e.target.value)}
          />
          <span className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-3 text-muted-foreground text-xs">
            {money.viewCurrency}
          </span>
        </div>
        <span
          id={`${id}-note`}
          // On a phone the note takes its own line under the field.
          className={cn(
            "order-last w-full text-sm sm:order-none sm:w-auto sm:min-w-0 sm:flex-1",
            invalid ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {invalid ? "Enter a number above zero." : rateNote({ entry, unsupported })}
        </span>
        <div className="ml-auto flex gap-1">
          {/* Enter saves too; the button shows once there is something to save. */}
          {changed && (
            <Button type="submit" size="sm" disabled={update.isPending}>
              Save
            </Button>
          )}
          {rate !== undefined && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ fxRates: { [currency]: null } }, { onError })}
            >
              Remove
            </Button>
          )}
        </div>
      </form>
    </li>
  );
}

function AddRateForm({ money }: { money: Money }) {
  const id = useId();
  const update = useUpdateSettings();
  const [code, setCode] = useState("");
  const [text, setText] = useState("");
  const parsed = CurrencyCode.safeParse(code);
  const value = rateFrom(text);
  const problem =
    code.trim() === ""
      ? null
      : !parsed.success
        ? "Use a three-letter currency code, such as USD."
        : parsed.data === money.viewCurrency
          ? `${parsed.data} is your view currency, so it needs no rate.`
          : text.trim() !== "" && value === null
            ? "Enter a number above zero."
            : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!parsed.success || value === null || problem) return;
    update.mutate(
      { fxRates: { [parsed.data]: value } },
      {
        onSuccess: () => {
          setCode("");
          setText("");
        },
        onError,
      },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-1 pt-1">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-code`}>Currency</Label>
          <Input
            id={`${id}-code`}
            className="w-24 uppercase"
            maxLength={3}
            autoComplete="off"
            spellCheck={false}
            placeholder="USD"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-rate`}>Rate in {money.viewCurrency}</Label>
          <Input
            id={`${id}-rate`}
            inputMode="decimal"
            className="w-32 tabular-nums"
            placeholder="Rate"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          disabled={update.isPending || value === null || !parsed.success || !!problem}
        >
          Add rate
        </Button>
      </div>
      {problem && (
        <p role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
    </form>
  );
}

/** The Fill rates button (decision 67). Off when no currency needs a fetched rate. */
function FillRatesButton({ money, pending, onFill }: { money: Money; pending: boolean; onFill: () => void }) {
  const needed = money.missingRates.length > 0 || money.fxRates.some((r) => r.by !== "user");
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={pending || !needed}
      title={needed ? undefined : "No currency needs a rate yet, and rates you typed stay as they are."}
      onClick={onFill}
    >
      {pending ? "Filling…" : "Fill rates"}
    </Button>
  );
}

/** "ECB rates of 16 Oct · fetched 2 hours ago", one line per source. */
function RateAges({ money }: { money: Money }) {
  const lines = fxAgeLines({ rates: money.fxRates, now: new Date() });
  if (lines.length === 0) return null;
  return (
    <ul className="grid gap-0.5 text-muted-foreground text-sm">
      {lines.map((l) => (
        <li key={l.by}>
          {l.source} rates of <time dateTime={l.rateDate}>{l.rateDay}</time> · fetched{" "}
          <time dateTime={l.fetchedAt}>{l.fetchedAgo}</time>
        </li>
      ))}
    </ul>
  );
}

/** View currency and FX rates: fetched automatically, or typed by hand (decisions 20 and 67). */
function MoneySection({ money }: { money: Money }) {
  const id = useId();
  const fill = useFillRates();
  const runFill = () => fill.mutate(undefined, { onSuccess: (res) => toast(fillRatesSummary(res.fill)), onError });
  const unsupported = new Set(money.fetch?.unsupported ?? []);
  return (
    <section aria-labelledby={`${id}-h`} className="grid gap-6">
      <SectionHeading
        id={`${id}-h`}
        title="Money"
        description="Rates fill from the ECB, or from currency-api for currencies the ECB does not publish. A rate you type is kept until you remove it."
      />
      <ViewCurrencyForm key={money.viewCurrency} money={money} onFill={runFill} />
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium text-sm">
            Rates{" "}
            {money.missingRates.length > 0 && (
              <span className="font-normal text-primary">· {money.missingRates.length} to set</span>
            )}
          </h3>
          <FillRatesButton money={money} pending={fill.isPending} onFill={runFill} />
        </div>
        <RateAges money={money} />
        {money.fetch?.error && (
          <p role="status" className="text-destructive text-sm">
            The last fetch, <time dateTime={money.fetch.at}>{SET_ON.format(new Date(money.fetch.at))}</time>, failed:{" "}
            {money.fetch.error} Your rates were kept.
          </p>
        )}
        {money.missingRates.length > 0 && (
          <p className="-mt-1 text-muted-foreground text-sm">
            Until a currency has a rate, its pay shows as posted and the pay filter never hides it.
          </p>
        )}
        {money.fxRates.length === 0 && money.missingRates.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No rates yet. Currencies from your jobs appear here when they need one.
          </p>
        ) : (
          <ul className="divide-y border-y text-sm" aria-label="Rates">
            {money.missingRates.map((currency) => (
              <RateRow
                key={`missing:${currency}`}
                money={money}
                currency={currency}
                unsupported={unsupported.has(currency)}
              />
            ))}
            {money.fxRates.map(({ currency, ...entry }) => (
              <RateRow
                key={`${currency}:${entry.rate}:${entry.setAt}`}
                money={money}
                currency={currency}
                entry={entry}
              />
            ))}
          </ul>
        )}
        <AddRateForm money={money} />
      </div>
    </section>
  );
}

/** HB_AI=pi (decision 48): pi signs in on its own, so there is no key to paste or models to pick. */
function PiRunner({ models }: { models: { light: string; writing: string } }) {
  const id = useId();
  return (
    <section className="grid gap-4" aria-labelledby={`${id}-h`}>
      <SectionHeading id={`${id}-h`} title="AI runs through pi on this machine" />
      <p className="max-w-prose text-muted-foreground text-sm">
        This copy was started with <code className="font-mono">HB_AI=pi</code>, so drafting uses pi&apos;s own sign-in
        and no key is stored. If a draft says pi is not signed in, run <code className="font-mono">pi</code> and use{" "}
        <code className="font-mono">/login</code>.
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Writing</dt>
        <dd className="font-mono">{models.writing}</dd>
        <dt className="text-muted-foreground">Light</dt>
        <dd className="font-mono">{models.light}</dd>
      </dl>
      <p className="max-w-prose text-muted-foreground text-sm">
        Change them with <code className="font-mono">HB_PI_MODEL_WRITING</code> and{" "}
        <code className="font-mono">HB_PI_MODEL_LIGHT</code>. Spend below is the list-price cost pi reports, which a pi
        subscription does not bill.
      </p>
    </section>
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
  const { ai, money, spend } = settings.data;
  const aiReady = ai.piModels !== null || ai.keyHint !== null;
  const sections: PageSection[] = [
    {
      // The setup checklist links to `/settings#ai`.
      id: "ai",
      label: "AI",
      hint: ai.piModels ? "pi" : ai.keyHint ? undefined : "No key",
      attention: !aiReady,
      content: (
        <div className="grid gap-8">
          {ai.piModels ? <PiRunner models={ai.piModels} /> : <KeyForm ai={ai} />}
          {!ai.piModels && <ModelsForm key={`${ai.provider}:${ai.modelLight}:${ai.modelWriting}`} ai={ai} />}
          <EligibilityToggle ai={ai} />
        </div>
      ),
    },
    {
      id: "spend",
      label: "Spend",
      hint: usd(spend.monthUsd),
      content: <SpendForm key={String(ai.monthlyCapUsd)} settings={settings.data} />,
    },
    {
      id: "money",
      label: "Money",
      hint: money.missingRates.length > 0 ? `${money.missingRates.length} to set` : money.viewCurrency,
      attention: money.missingRates.length > 0,
      content: <MoneySection money={money} />,
    },
    {
      // Not `extension`: the pairing section inside already has that id.
      id: "chrome-extension",
      label: "Chrome extension",
      content: <ExtensionPairing />,
    },
  ];
  return <SectionPage title="Settings" sections={sections} />;
}
