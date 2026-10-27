import { type MarkReviewedInput, TaskDto } from "@shared/api";
import {
  ActiveSessionResponse,
  type ApplicationSessionId,
  ClaimSessionResult,
  ExtensionOutputDto,
  ExtensionOutputList,
  PreferenceDto,
  PrefillResponse,
  UrlMismatchDetails,
} from "@shared/extension";
import { AnswerReferenceDto, QuestionLookupResult } from "@shared/extension-answers";
import { createClient, ROUTES } from "../api/client";
import type { PanelReply, PanelRequest, PanelResult } from "../messages";
import { type DiagnosticsLog, isRecorded, requestEntry } from "../state/diagnostics";
import type { SessionBinding, Store } from "../state/storage";
import { chromeSendAnswer, readTabAnswer, type SendAnswer } from "./answers";
import { type ContentDeps, fillTab, fromOutcome, localReply, refusedReply, scanTab, storedStatus } from "./content";
import { type AttachDeps, attachDeps, handleAttach } from "./files";
import { handleImport, type ImportDeps } from "./import";
import { disconnect, getStatus, type PairingDeps, pair } from "./pairing";
import { type PermissionsApi, revokeOriginAccess, syncGrantedOrigins } from "./permissions";

// The worker's answer to every side-panel request. index.ts only wires Chrome to this; tests call
// it with in-memory storage, a fake fetch and fake tabs. Fail closed: no pairing, no server, or a
// request for a session or tab other than the bound one does nothing.

export type PanelDeps = {
  pairing: PairingDeps;
  content: ContentDeps;
  permissions: PermissionsApi;
  now: () => number;
  /** Sends `read_job` and `success_probe` to frame 0. `chromeSendImport` in the worker. */
  sendImport: ImportDeps["sendContent"];
  /** One explicit text-field read, only after the session and active tab were checked. */
  sendAnswer?: SendAnswer;
  /** Chrome Downloads by default; tests pass a fake. */
  download?: AttachDeps["download"] | undefined;
  /** The metadata-only ring buffer (state/diagnostics.ts). */
  diagnostics: DiagnosticsLog;
};

type Reply = Promise<PanelReply>;

/** The binding, when it is for `sessionId`; null otherwise. */
async function boundTo(store: Store, sessionId: string): Promise<SessionBinding | null> {
  const binding = await store.readBinding();
  return binding !== null && binding.sessionId === sessionId ? binding : null;
}

type Request<K extends PanelRequest["kind"]> = Extract<PanelRequest, { kind: K }>;

const claims = new WeakMap<Store, { sessionId: ApplicationSessionId }>();

async function activeSession(deps: PanelDeps): Reply {
  const store = deps.pairing.store;
  const binding = await store.readBinding();
  const pendingClaim = claims.get(store);
  const outcome = await createClient(deps.pairing).call({ route: ROUTES.activeSession, schema: ActiveSessionResponse });
  return fromOutcome({
    deps,
    outcome,
    scope: "none",
    ok: async (active) => {
      const activeId = active.kind === "active" ? active.session.id : null;
      if (binding !== null && binding.sessionId !== activeId) await store.clearBinding(binding.sessionId);
      if (pendingClaim !== undefined && claims.get(store) === pendingClaim && pendingClaim.sessionId !== activeId)
        claims.delete(store);
      return { kind: "session_active", active };
    },
  });
}

async function claim(deps: PanelDeps, request: Request<"session_claim">): Reply {
  const attempt = { sessionId: request.sessionId };
  claims.set(deps.pairing.store, attempt);
  if ((await storedStatus(deps.pairing.store)).kind !== "paired") return getStatus({ deps: deps.pairing });
  const tab = await deps.content.getTab(request.tabId);
  if (tab === null || tab.url === null) return refusedReply(deps, "unsupported_url");
  if (tab.url !== request.tabUrl) return refusedReply(deps, "tab_changed");

  const outcome = await createClient(deps.pairing).call({
    route: ROUTES.claimSession,
    params: { id: request.sessionId },
    body: { tabUrl: tab.url, confirmMismatch: request.confirmMismatch },
    schema: ClaimSessionResult,
  });
  if (claims.get(deps.pairing.store) !== attempt) return refusedReply(deps, "not_bound");
  if (outcome.kind === "failed" && outcome.code === "url_mismatch") {
    const details = UrlMismatchDetails.safeParse(outcome.details);
    if (details.success) return localReply(deps, { kind: "claim_mismatch", details: details.data });
  }
  return fromOutcome({
    deps,
    outcome,
    scope: "none",
    ok: async ({ session }) => {
      await deps.pairing.store.saveBinding({
        sessionId: session.id,
        opportunityId: session.opportunityId,
        tabId: request.tabId,
        claimedAt: deps.now(),
      });
      return { kind: "claimed", session };
    },
  });
}

async function scan(deps: PanelDeps, request: Request<"scan">): Reply {
  if ((await storedStatus(deps.pairing.store)).kind !== "paired") return getStatus({ deps: deps.pairing });
  const binding = await deps.pairing.store.readBinding();
  if (binding === null || binding.tabId !== request.tabId) return refusedReply(deps, "not_bound");
  const out = await scanTab({ deps: deps.content, tabId: request.tabId });
  if (out.kind === "refused") return refusedReply(deps, out.reason);
  const { nonce, adapter, fields } = out.result;
  return localReply(deps, { kind: "scanned", nonce, adapter, fields });
}

async function prefill(deps: PanelDeps, request: Request<"prefill">): Reply {
  if ((await boundTo(deps.pairing.store, request.sessionId)) === null) return refusedReply(deps, "not_bound");
  const outcome = await createClient(deps.pairing).call({
    route: ROUTES.prefill,
    params: { id: request.sessionId },
    body: { nonce: request.nonce, fields: request.fields },
    schema: PrefillResponse,
  });
  return fromOutcome({
    deps,
    outcome,
    scope: { kind: "session", sessionId: request.sessionId },
    ok: (response): PanelResult =>
      response.nonce === request.nonce
        ? { kind: "prefilled", response }
        : { kind: "failed", code: "bad_response", message: "The server answered for another scan. Scan again." },
  });
}

/** Ping first: with the pairing revoked or the server down, nothing fills. */
async function fill(deps: PanelDeps, request: Request<"fill">): Reply {
  const status = await getStatus({ deps: deps.pairing });
  if (status.status.kind !== "paired") return status;
  const out = await fillTab({ deps: deps.content, tabId: request.tabId, plan: request.plan });
  if (out.kind === "refused") return refusedReply(deps, out.reason);
  const { nonce, filled, skipped } = out.result;
  return localReply(deps, { kind: "filled", result: { nonce, filled, skipped } });
}

async function savePreference(deps: PanelDeps, request: Request<"preference_save">): Reply {
  const { scope } = request.input;
  if (scope.kind === "opportunity") {
    const binding = await deps.pairing.store.readBinding();
    if (binding === null || binding.opportunityId !== scope.opportunityId) return refusedReply(deps, "not_bound");
  }
  const outcome = await createClient(deps.pairing).call({
    route: ROUTES.savePreference,
    body: request.input,
    schema: PreferenceDto,
  });
  return fromOutcome({ deps, outcome, scope: "none", ok: (preference) => ({ kind: "preference", preference }) });
}

async function sessionCall(
  deps: PanelDeps,
  request: Request<
    | "outputs_list"
    | "output_reviewed"
    | "draft_start"
    | "questions_lookup"
    | "question_create"
    | "answer_reference_save"
  >,
): Reply {
  if ((await boundTo(deps.pairing.store, request.sessionId)) === null) return refusedReply(deps, "not_bound");
  const client = createClient(deps.pairing);
  switch (request.kind) {
    case "questions_lookup":
      return fromOutcome({
        deps,
        scope: { kind: "session", sessionId: request.sessionId },
        outcome: await client.call({
          route: ROUTES.questions,
          params: { id: request.sessionId },
          body: request.input,
          schema: QuestionLookupResult,
        }),
        ok: (data) => ({ kind: "questions", data }),
      });
    case "question_create":
      return fromOutcome({
        deps,
        scope: { kind: "session", sessionId: request.sessionId },
        outcome: await client.call({
          route: ROUTES.createQuestion,
          params: { id: request.sessionId },
          body: request.input,
          schema: ExtensionOutputDto,
        }),
        ok: (output) => ({ kind: "output", output }),
      });
    case "answer_reference_save":
      return fromOutcome({
        deps,
        scope: { kind: "session", sessionId: request.sessionId },
        outcome: await client.call({
          route: ROUTES.saveAnswerReference,
          params: { id: request.sessionId },
          body: request.input,
          schema: AnswerReferenceDto,
        }),
        ok: (reference) => ({ kind: "answer_reference", reference }),
      });
    case "outputs_list":
      return fromOutcome({
        deps,
        scope: { kind: "session", sessionId: request.sessionId },
        outcome: await client.call({
          route: ROUTES.outputs,
          params: { id: request.sessionId },
          schema: ExtensionOutputList,
        }),
        ok: ({ outputs }) => ({ kind: "outputs", outputs }),
      });
    case "output_reviewed":
      return fromOutcome({
        deps,
        scope: { kind: "output", sessionId: request.sessionId },
        outcome: await client.call({
          route: ROUTES.reviewOutput,
          params: { id: request.sessionId, outputId: request.outputId },
          body: { body: request.body } satisfies MarkReviewedInput,
          schema: ExtensionOutputDto,
        }),
        ok: (output) => ({ kind: "output", output }),
      });
    case "draft_start":
      return fromOutcome({
        deps,
        scope: { kind: "session", sessionId: request.sessionId },
        outcome: await client.call({
          route: ROUTES.draft,
          params: { id: request.sessionId },
          body: { outputId: request.outputId, confirmOverCap: request.confirmOverCap },
          schema: TaskDto,
        }),
        ok: (task) => ({ kind: "task", task }),
      });
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

/** Attach click or its Download fallback (files.ts). Both fetch one output's PDF. */
async function attach(deps: PanelDeps, request: Request<"attach" | "attach_download">): Reply {
  const outcome = await handleAttach({
    deps: attachDeps({ pairing: deps.pairing, content: deps.content, download: deps.download }),
    request,
  });
  if (outcome.kind === "refused") return refusedReply(deps, outcome.reason);
  return fromOutcome({
    deps,
    outcome,
    scope: { kind: "output", sessionId: request.sessionId },
    ok: (result) => result,
  });
}

async function pollTask(deps: PanelDeps, request: Request<"task_poll">): Reply {
  const binding = await deps.pairing.store.readBinding();
  if (binding === null) return refusedReply(deps, "not_bound");
  const outcome = await createClient(deps.pairing).call({
    route: ROUTES.task,
    params: { id: request.taskId },
    schema: TaskDto,
  });
  return fromOutcome({
    deps,
    outcome,
    // This task may belong to a previous job. Its 404 says nothing about the current binding.
    scope: "none",
    ok: (task) => ({ kind: "task", task }),
  });
}

/** Read or empty the diagnostics log. Local only: no server call, so no ping either. */
async function diagnostics(deps: PanelDeps, request: Request<"diagnostics_list" | "diagnostics_clear">): Reply {
  if (request.kind === "diagnostics_clear") await deps.diagnostics.clear();
  return localReply(deps, { kind: "diagnostics", entries: await deps.diagnostics.list() });
}

/**
 * Answer a panel request, then record one metadata entry for it. A log that cannot be written
 * never changes the reply.
 */
export async function handlePanelRequest({ deps, request }: { deps: PanelDeps; request: PanelRequest }): Reply {
  const reply = await answer(deps, request);
  if (isRecorded(request)) {
    await requestEntry({ request, reply, ts: deps.now(), getTab: deps.content.getTab })
      .then((entry) => deps.diagnostics.record(entry))
      .catch(() => undefined);
  }
  return reply;
}

/**
 * One switch on the request kind. `routeMessage` already checked the sender is this extension's
 * own page and the request parses; this checks pairing, binding and tab before acting.
 */
async function answer(deps: PanelDeps, request: PanelRequest): Reply {
  switch (request.kind) {
    case "status":
      return getStatus({ deps: deps.pairing });
    case "pair":
      return pair({ deps: deps.pairing, endpoint: request.endpoint, code: request.code });
    case "disconnect":
      return disconnect({ deps: deps.pairing });
    case "session_active":
      return activeSession(deps);
    case "session_claim":
      return claim(deps, request);
    case "scan":
      return scan(deps, request);
    case "prefill":
      return prefill(deps, request);
    case "fill":
      return fill(deps, request);
    case "sync_origins":
      return localReply(deps, {
        kind: "origins",
        origins: await syncGrantedOrigins({ store: deps.pairing.store, permissions: deps.permissions }),
      });
    case "revoke_origin":
      return localReply(deps, {
        kind: "origins",
        origins: await revokeOriginAccess({
          origin: request.origin,
          store: deps.pairing.store,
          permissions: deps.permissions,
        }),
      });
    case "preference_save":
      return savePreference(deps, request);
    case "answer_read": {
      const binding = await boundTo(deps.pairing.store, request.sessionId);
      if (binding === null || binding.tabId !== request.tabId) return refusedReply(deps, "not_bound");
      // Validate the live claim before reading a value. This lookup sends field metadata only.
      const live = await createClient(deps.pairing).call({
        route: ROUTES.questions,
        params: { id: request.sessionId },
        body: { fields: [request.field] },
        schema: QuestionLookupResult,
      });
      if (live.kind !== "ok")
        return fromOutcome({
          deps,
          outcome: live,
          scope: { kind: "session", sessionId: request.sessionId },
          ok: () => ({ kind: "refused", reason: "bad_reply" }),
        });
      const result = await readTabAnswer({
        deps: deps.content,
        send: deps.sendAnswer ?? chromeSendAnswer,
        tabId: request.tabId,
        message: { kind: "read_answer", nonce: request.nonce, field: request.field },
      });
      return localReply(deps, result);
    }
    case "questions_lookup":
    case "question_create":
    case "answer_reference_save":
    case "outputs_list":
    case "output_reviewed":
    case "draft_start":
      return sessionCall(deps, request);
    case "task_poll":
      return pollTask(deps, request);
    case "diagnostics_list":
    case "diagnostics_clear":
      return diagnostics(deps, request);
    case "attach":
    case "attach_download":
      return attach(deps, request);
    case "job_extract":
    case "job_lookup":
    case "job_import":
    case "success_check":
    case "confirm_applied":
      return handleImport({
        deps: { pairing: deps.pairing, content: deps.content, sendContent: deps.sendImport },
        request,
      });
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}
