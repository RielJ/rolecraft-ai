import {
  DECLINE_VALUE,
  PREFILL_CATEGORIES,
  type PrefillCategory,
  type PrefillCategorySpec,
  type TypedValue,
} from "@shared/extension";
import { useState } from "react";
import type { PanelEvent, PreferenceScopeKind, SaveCandidate, SaveStatus } from "./state";

// "Save as default" / "Save for this job" for a field the profile had no answer for, or one the
// user edited. Shown only after a fill and only saved on one of those two clicks.

const CATEGORY_LABELS: Record<PrefillCategory, string> = {
  given_name: "First name",
  family_name: "Last name",
  full_name: "Full name",
  email: "Email",
  phone: "Phone",
  location: "Location",
  linkedin: "LinkedIn",
  github: "GitHub",
  portfolio: "Portfolio",
  website: "Website",
  references: "References",
  referral_source: "How you heard about the job",
  work_authorization: "Authorized to work",
  requires_sponsorship: "Needs sponsorship",
  notice_period: "Notice period",
  start_date: "Start date",
  willing_to_relocate: "Willing to relocate",
  work_arrangement: "Work arrangement",
  willing_to_travel: "Willing to travel",
  gender: "Gender",
  race_ethnicity: "Race or ethnicity",
  veteran_status: "Veteran status",
  disability_status: "Disability",
};

const CHOICE_LABELS: Readonly<Record<string, string>> = {
  [DECLINE_VALUE]: "I don't wish to answer",
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
  female: "Female",
  male: "Male",
  non_binary: "Non-binary",
  hispanic_latino: "Hispanic or Latino",
  white: "White",
  black: "Black or African American",
  asian: "Asian",
  american_indian_alaska_native: "American Indian or Alaska Native",
  native_hawaiian_pacific_islander: "Native Hawaiian or Pacific Islander",
  two_or_more: "Two or more races",
  protected_veteran: "Protected veteran",
  not_protected_veteran: "Not a protected veteran",
  yes: "Yes",
  no: "No",
};

function choiceLabel(value: string): string {
  return CHOICE_LABELS[value] ?? value.replaceAll("_", " ");
}

/** The typed value and its display text for what the user entered, or null while it's empty. */
function valueFor(spec: PrefillCategorySpec, raw: string): { typedValue: TypedValue; displayText: string } | null {
  const text = raw.trim();
  if (text === "") return null;
  switch (spec.valueType) {
    case "text":
      return { typedValue: { valueType: "text", value: text }, displayText: text };
    case "date":
      return { typedValue: { valueType: "date", value: text }, displayText: text };
    case "yesNo":
      return { typedValue: { valueType: "yesNo", value: text === "yes" }, displayText: text === "yes" ? "Yes" : "No" };
    case "choice":
      return { typedValue: { valueType: "choice", value: text }, displayText: choiceLabel(text) };
    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }
}

function ValueInput({
  spec,
  id,
  value,
  onChange,
  disabled,
}: {
  spec: PrefillCategorySpec;
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  switch (spec.valueType) {
    case "text":
      return (
        <input
          id={id}
          className="field w-full"
          value={value}
          maxLength={2000}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "date":
      return (
        <input
          id={id}
          type="date"
          className="field w-full"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "yesNo":
      return <Choices id={id} options={["yes", "no"]} value={value} onChange={onChange} disabled={disabled} />;
    case "choice":
      return <Choices id={id} options={spec.choices} value={value} onChange={onChange} disabled={disabled} />;
    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }
}

function Choices({
  id,
  options,
  value,
  onChange,
  disabled,
}: {
  id: string;
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <select
      id={id}
      className="field w-full bg-background"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Choose…</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {choiceLabel(o)}
        </option>
      ))}
    </select>
  );
}

function statusText(status: SaveStatus | undefined): string | null {
  if (status === undefined) return null;
  switch (status.kind) {
    case "saving":
      return "Saving…";
    case "saved":
      return status.scope === "global" ? "Saved as your default." : "Saved for this job.";
    case "failed":
      return status.message;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function SaveRow({
  candidate,
  status,
  dispatch,
}: {
  candidate: SaveCandidate;
  status: SaveStatus | undefined;
  dispatch: (event: PanelEvent) => void;
}) {
  const spec: PrefillCategorySpec = PREFILL_CATEGORIES[candidate.category];
  const [raw, setRaw] = useState(spec.valueType === "text" ? (candidate.initialText ?? "") : "");
  const value = valueFor(spec, raw);
  const saving = status?.kind === "saving";
  const id = `save-${candidate.category}`;
  const message = statusText(status);

  function save(scope: PreferenceScopeKind) {
    if (value === null) return;
    dispatch({ kind: "save_clicked", category: candidate.category, ...value, scope });
  }

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <label htmlFor={id} className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{CATEGORY_LABELS[candidate.category]}</span>
        <span className="text-xs text-muted-foreground break-words">Asked as “{candidate.label}”</span>
      </label>
      <ValueInput spec={spec} id={id} value={raw} onChange={setRaw} disabled={saving} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={saving || value === null}
          onClick={() => save("global")}
        >
          Save as default
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={saving || value === null}
          onClick={() => save("opportunity")}
        >
          Save for this job
        </button>
      </div>
      {message !== null && (
        <p
          role={status?.kind === "failed" ? "alert" : "status"}
          className={status?.kind === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {message}
        </p>
      )}
    </li>
  );
}

export function SavePreference({
  candidates,
  saves,
  dispatch,
}: {
  candidates: readonly SaveCandidate[];
  saves: Readonly<Partial<Record<PrefillCategory, SaveStatus>>>;
  dispatch: (event: PanelEvent) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <section aria-labelledby="save-title" className="flex flex-col gap-1.5">
      <h3 id="save-title" className="text-sm font-semibold">
        Save answers for next time
      </h3>
      <p className="text-xs text-muted-foreground">
        Nothing is saved unless you click a button. A default applies to every job; a job answer only to this one.
      </p>
      <ul className="divide-y divide-border rounded-control border border-border">
        {candidates.map((c) => (
          <SaveRow key={c.category} candidate={c} status={saves[c.category]} dispatch={dispatch} />
        ))}
      </ul>
    </section>
  );
}
