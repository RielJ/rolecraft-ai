import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { CurrencyCode, isValidCap, MIN_CAP_USD, type SettingsDto } from "@/shared/api";
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
    <form id="ai" onSubmit={submit} className="grid max-w-2xl gap-4" aria-labelledby={`${id}-h`}>
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
            ? `Enter an amount of at least ${usd(MIN_CAP_USD)}, like 5 or 12.50, or leave it empty for no cap.`
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

function ViewCurrencyForm({ money }: { money: Money }) {
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
        onSuccess: () =>
          toast(
            money.fxRates.length
              ? `Pay now shows in ${parsed.data}. Your rates were cleared.`
              : `Pay now shows in ${parsed.data}.`,
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
      <p id={`${id}-help`} className={parsed.success ? "text-muted-foreground text-sm" : "text-destructive text-sm"}>
        {parsed.success
          ? "Pay shows as a monthly amount in this currency. Changing it clears your rates, since they are relative to it."
          : "Use a three-letter currency code, such as PHP or USD."}
      </p>
    </form>
  );
}

/** One currency's rate: set, changed or removed. A currency with no rate yet shows an empty field. */
function RateRow({ money, currency, rate, setAt }: { money: Money; currency: string; rate?: number; setAt?: string }) {
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

  return (
    <li>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Label htmlFor={`${id}-rate`} className="w-14 font-normal tabular-nums">
          1 {currency} =
        </Label>
        <Input
          id={`${id}-rate`}
          inputMode="decimal"
          className="w-32 tabular-nums"
          placeholder="No rate"
          value={text}
          aria-invalid={invalid}
          aria-describedby={`${id}-note`}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="text-muted-foreground">{money.viewCurrency}</span>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={update.isPending || value === null || value === rate}
        >
          Save
        </Button>
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
        <span id={`${id}-note`} className={invalid ? "text-destructive text-sm" : "text-muted-foreground text-sm"}>
          {invalid
            ? "Enter a number above zero, like 57.80."
            : setAt
              ? `Set ${SET_ON.format(new Date(setAt))}`
              : `${currency} pay shows as posted until you set a rate.`}
        </span>
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
            ? "Enter a number above zero, like 57.80."
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
    <form onSubmit={submit} className="grid gap-1">
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
            placeholder="57.80"
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

/** View currency and hand-typed FX rates (decision 20, Q12). */
function MoneySection({ money }: { money: Money }) {
  const id = useId();
  return (
    <section id="money" aria-labelledby={`${id}-h`} className="grid max-w-2xl scroll-mt-20 gap-6">
      <div>
        <h2 id={`${id}-h`} className="font-semibold text-lg">
          Money
        </h2>
        <p className="text-muted-foreground text-sm">
          Rates are typed by hand and used as they are, so a change re-prices every job at once.
        </p>
      </div>
      <ViewCurrencyForm key={money.viewCurrency} money={money} />
      <div className="grid gap-3">
        <h3 className="font-medium text-sm">Rates</h3>
        {money.fxRates.length === 0 && money.missingRates.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No rates yet. Currencies from your jobs appear here when they need one.
          </p>
        ) : (
          <ul className="grid gap-2 text-sm">
            {money.missingRates.map((currency) => (
              <RateRow key={`missing:${currency}`} money={money} currency={currency} />
            ))}
            {money.fxRates.map((r) => (
              <RateRow
                key={`${r.currency}:${r.rate}:${r.setAt}`}
                money={money}
                currency={r.currency}
                rate={r.rate}
                setAt={r.setAt}
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
    <section className="grid max-w-2xl gap-3" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="font-semibold text-lg">
        AI runs through pi on this machine
      </h2>
      <p className="text-muted-foreground text-sm">
        This copy was started with <code className="font-mono">HB_AI=pi</code>, so drafting uses pi&apos;s own sign-in
        and no key is stored. If a draft says pi is not signed in, run <code className="font-mono">pi</code> and use{" "}
        <code className="font-mono">/login</code>.
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Writing</dt>
        <dd className="font-mono">{models.writing}</dd>
        <dt className="text-muted-foreground">Light</dt>
        <dd className="font-mono">{models.light}</dd>
      </dl>
      <p className="text-muted-foreground text-sm">
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
  const { ai, money } = settings.data;
  return (
    <div className="grid gap-10">
      <h1 className="display text-3xl">Settings</h1>
      {ai.piModels ? <PiRunner models={ai.piModels} /> : <KeyForm ai={ai} />}
      <Separator />
      <SpendForm key={String(ai.monthlyCapUsd)} settings={settings.data} />
      <Separator />
      {!ai.piModels && <ModelsForm key={`${ai.provider}:${ai.modelLight}:${ai.modelWriting}`} ai={ai} />}
      <EligibilityToggle ai={ai} />
      <Separator />
      <MoneySection money={money} />
    </div>
  );
}
