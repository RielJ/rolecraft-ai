import { keepPreviousData, skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  AddJobResult,
  type AddLinkInput,
  AddLinkResult,
  type AddonInput,
  BoardItemDto,
  type ChangeStatusInput,
  type DraftInput,
  type FactId,
  type ItemId,
  type JobId,
  MatchDetail,
  MatchList,
  type MatchQueryInput,
  MergeResult,
  type OpportunityId,
  type OutputId,
  type PasteJobInput,
  ProfileDto,
  RefreshDto,
  type SaveAiKeyInput,
  SavedJob,
  SettingsDto,
  SourceDto,
  type SourceId,
  SourceList,
  TaskDto,
  type TaskId,
  TextExport,
  type UpdateOpportunityInput,
  type UpdateOutputInput,
  type UpdateProfileInput,
  type UpdateSettingsInput,
  WorkspaceDto,
} from "@/shared/api";
import type { DismissReason } from "@/shared/enums";
import { client, toApiError, unwrap } from "./api";

export const keys = {
  profile: ["profile"] as const,
  board: ["board"] as const,
  workspace: (id: OpportunityId) => ["workspace", id] as const,
  settings: ["settings"] as const,
  sources: ["sources"] as const,
  matches: ["matches"] as const,
  matchList: (query: MatchQueryInput) => ["matches", "list", query] as const,
  match: (id: JobId) => ["matches", "detail", id] as const,
  refresh: ["refresh"] as const,
};

/** How often the workspace polls while a draft task runs. */
const TASK_POLL_MS = 1000;

// ---------- Profile ----------

/** True while the CV or an add-on is being split into facts. */
export const splitRunning = (profile: ProfileDto | undefined): boolean =>
  [profile?.cv, ...(profile?.addons ?? [])].some((item) => item?.splitTask?.status === "running");

export function useProfile() {
  return useQuery({
    queryKey: keys.profile,
    queryFn: () => unwrap(client.api.profile.$get(), ProfileDto),
    // New facts arrive by polling while a split task runs.
    refetchInterval: (query) => (splitRunning(query.state.data) ? TASK_POLL_MS : false),
  });
}

function useProfileMutation<I>(run: (input: I) => Promise<ProfileDto>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (profile) => {
      qc.setQueryData(keys.profile, profile);
      // Standard answers and fact text feed every workspace's gate.
      void qc.invalidateQueries({ queryKey: ["workspace"] });
      void qc.invalidateQueries({ queryKey: keys.board });
      // Confirmed facts and targeting set match levels, tags and the pay filter, on every read.
      void qc.invalidateQueries({ queryKey: keys.matches });
    },
  });
}

export const useUpdateProfile = () =>
  useProfileMutation((json: UpdateProfileInput) => unwrap(client.api.profile.$put({ json }), ProfileDto));

export const usePasteCv = () =>
  useProfileMutation(({ text, confirmOverCap }: { text: string; confirmOverCap?: boolean }) =>
    unwrap(client.api.profile.cv.$put({ json: { text, confirmOverCap } }), ProfileDto),
  );

/** Upload a PDF or DOCX. The server reads it once and keeps only the text. */
export const useUploadCv = () =>
  useProfileMutation(({ file, confirmOverCap }: { file: File; confirmOverCap?: boolean }) =>
    unwrap(
      client.api.profile.cv.file.$post({ form: { file, confirmOverCap: confirmOverCap ? "true" : "false" } }),
      ProfileDto,
    ),
  );

export const useCreateAddon = () =>
  useProfileMutation((json: AddonInput) => unwrap(client.api.profile.addons.$post({ json }), ProfileDto));

export const useUpdateAddon = () =>
  useProfileMutation(({ id, ...json }: { id: ItemId } & AddonInput) =>
    unwrap(client.api.profile.addons[":id"].$put({ param: { id }, json }), ProfileDto),
  );

export const useDeleteAddon = () =>
  useProfileMutation((id: ItemId) => unwrap(client.api.profile.addons[":id"].$delete({ param: { id } }), ProfileDto));

/** Keep a fact that is not in the latest version of its CV or add-on. */
export const useKeepFact = () =>
  useProfileMutation((id: FactId) => unwrap(client.api.facts[":id"].keep.$post({ param: { id } }), ProfileDto));

/** Retry a failed split. The profile refetch picks up the new task and polls it. */
export function useRetrySplit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmOverCap }: { id: TaskId; confirmOverCap?: boolean }) =>
      unwrap(client.api.tasks[":id"].retry.$post({ param: { id }, json: { confirmOverCap } }), TaskDto),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.profile }),
  });
}

export const useConfirmFact = () =>
  useProfileMutation((id: FactId) => unwrap(client.api.facts[":id"].confirm.$post({ param: { id } }), ProfileDto));

export const useConfirmAllFacts = () =>
  useProfileMutation(() => unwrap(client.api.facts["confirm-all"].$post(), ProfileDto));

export const useUpdateFact = () =>
  useProfileMutation(({ id, text }: { id: FactId; text: string }) =>
    unwrap(client.api.facts[":id"].$patch({ param: { id }, json: { text } }), ProfileDto),
  );

export const useDeleteFact = () =>
  useProfileMutation((id: FactId) => unwrap(client.api.facts[":id"].$delete({ param: { id } }), ProfileDto));

// ---------- Jobs and board ----------

export function useBoard() {
  return useQuery({ queryKey: keys.board, queryFn: () => unwrap(client.api.board.$get(), z.array(BoardItemDto)) });
}

/** A new job changes the board, and its pay currency may need a rate in Settings. */
function useJobAdded() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.board }),
      // A job added by link may be one Matches listed; saved jobs leave Matches.
      qc.invalidateQueries({ queryKey: keys.matches }),
      qc.invalidateQueries({ queryKey: keys.settings }),
      // Other jobs' duplicate hints are computed on read.
      qc.invalidateQueries({ queryKey: ["workspace"] }),
    ]);
}

export function useAddPastedJob() {
  const onSuccess = useJobAdded();
  return useMutation({
    mutationFn: (json: PasteJobInput) => unwrap(client.api.jobs["from-paste"].$post({ json }), AddJobResult),
    onSuccess,
  });
}

export function useAddJobFromLink() {
  const onSuccess = useJobAdded();
  return useMutation({
    mutationFn: (json: AddLinkInput) => unwrap(client.api.jobs["from-link"].$post({ json }), AddLinkResult),
    onSuccess,
  });
}

/** Put an item in its new state, keeping every other row as it was. */
function patchBoard(items: BoardItemDto[] | undefined, next: BoardItemDto): BoardItemDto[] | undefined {
  return items?.map((item) => (item.opportunityId === next.opportunityId ? next : item));
}

/**
 * Move an opportunity on the board. The row moves at once; a failure puts it back, and the
 * caller toasts the reason (section 4, Board).
 */
export function useChangeStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ opportunityId, ...json }: { opportunityId: OpportunityId } & ChangeStatusInput) =>
      unwrap(client.api.opportunities[":id"].status.$post({ param: { id: opportunityId }, json }), BoardItemDto),
    onMutate: async ({ opportunityId, ...change }) => {
      await qc.cancelQueries({ queryKey: keys.board });
      const before = qc.getQueryData<BoardItemDto[]>(keys.board);
      const item = before?.find((i) => i.opportunityId === opportunityId);
      if (item) {
        const outcome = change.status === "closed" ? change.outcome : null;
        qc.setQueryData(keys.board, patchBoard(before, { ...item, status: change.status, outcome, followUp: null }));
      }
      return { before };
    },
    onError: (_error, _input, context) => {
      if (context?.before) qc.setQueryData(keys.board, context.before);
    },
    onSuccess: (item) => qc.setQueryData(keys.board, (items: BoardItemDto[] | undefined) => patchBoard(items, item)),
    onSettled: (_item, _error, { opportunityId }) => {
      void qc.invalidateQueries({ queryKey: keys.board });
      void qc.invalidateQueries({ queryKey: keys.workspace(opportunityId) });
    },
  });
}

// ---------- Workspace ----------

export function useWorkspace(id: OpportunityId) {
  return useQuery({
    queryKey: keys.workspace(id),
    queryFn: () => unwrap(client.api.opportunities[":id"].$get({ param: { id } }), WorkspaceDto),
    // The draft task's step and the drafted bodies arrive by polling the workspace.
    refetchInterval: (query) => (query.state.data?.draftTask?.status === "running" ? TASK_POLL_MS : false),
  });
}

function useWorkspaceMutation<I>(id: OpportunityId, run: (input: I) => Promise<WorkspaceDto>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (ws) => {
      qc.setQueryData(keys.workspace(id), ws);
      void qc.invalidateQueries({ queryKey: keys.board });
    },
  });
}

export const useUpdateOutput = (opportunityId: OpportunityId) =>
  useWorkspaceMutation(opportunityId, ({ id, ...json }: { id: OutputId } & UpdateOutputInput) =>
    unwrap(client.api.outputs[":id"].$patch({ param: { id }, json }), WorkspaceDto),
  );

export const useAddQuestion = (opportunityId: OpportunityId) =>
  useWorkspaceMutation(opportunityId, (question: string) =>
    unwrap(
      client.api.opportunities[":id"].questions.$post({ param: { id: opportunityId }, json: { question } }),
      WorkspaceDto,
    ),
  );

export const useDeleteQuestion = (opportunityId: OpportunityId) =>
  useWorkspaceMutation(opportunityId, (id: OutputId) =>
    unwrap(client.api.outputs[":id"].$delete({ param: { id } }), WorkspaceDto),
  );

/** Notes, job or contract, and contract terms. Allowed on applied jobs too. */
export const useUpdateOpportunity = (opportunityId: OpportunityId) =>
  useWorkspaceMutation(opportunityId, (json: UpdateOpportunityInput) =>
    unwrap(client.api.opportunities[":id"].$patch({ param: { id: opportunityId }, json }), WorkspaceDto),
  );

export const useMarkOutputCurrent = (opportunityId: OpportunityId) =>
  useWorkspaceMutation(opportunityId, (id: OutputId) =>
    unwrap(client.api.outputs[":id"]["mark-current"].$post({ param: { id } }), WorkspaceDto),
  );

/** Start a draft task. The workspace refetch picks up the running task and polls it. */
export function useDraft(opportunityId: OpportunityId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (json: DraftInput) =>
      unwrap(client.api.opportunities[":id"].draft.$post({ param: { id: opportunityId }, json }), TaskDto),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.workspace(opportunityId) }),
  });
}

export function useRetryTask(opportunityId: OpportunityId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmOverCap }: { id: TaskId; confirmOverCap?: boolean }) =>
      unwrap(client.api.tasks[":id"].retry.$post({ param: { id }, json: { confirmOverCap } }), TaskDto),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.workspace(opportunityId) }),
  });
}

export function useMarkReady(opportunityId: OpportunityId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        client.api.opportunities[":id"].ready.$post({ param: { id: opportunityId } }),
        z.object({ ready: z.literal(true) }),
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.workspace(opportunityId) });
      void qc.invalidateQueries({ queryKey: keys.board });
    },
  });
}

export async function fetchText(id: OutputId): Promise<string> {
  return (await unwrap(client.api.outputs[":id"].text.$get({ param: { id } }), TextExport)).text;
}

/** Fetch the gated PDF and hand it to the browser as a download. */
export async function downloadPdf(id: OutputId): Promise<void> {
  const res = await client.api.outputs[":id"]["export.pdf"].$get({ param: { id } });
  if (!res.ok) throw await toApiError(res);
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const filename = match?.[1] ? decodeURIComponent(match[1]) : "application.pdf";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- Settings ----------

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => unwrap(client.api.settings.$get(), SettingsDto) });
}

function useSettingsMutation<I>(run: (input: I) => Promise<SettingsDto>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (settings) => {
      qc.setQueryData(keys.settings, settings);
      // aiReady on every workspace follows the key.
      void qc.invalidateQueries({ queryKey: ["workspace"] });
      // The view currency and rates set the pay shown and the pay filter on Matches.
      void qc.invalidateQueries({ queryKey: keys.matches });
    },
  });
}

export const useSaveAiKey = () =>
  useSettingsMutation((json: SaveAiKeyInput) => unwrap(client.api.settings["ai-key"].$put({ json }), SettingsDto));

export const useRemoveAiKey = () =>
  useSettingsMutation(() => unwrap(client.api.settings["ai-key"].$delete(), SettingsDto));

export const useUpdateSettings = () =>
  useSettingsMutation((json: UpdateSettingsInput) => unwrap(client.api.settings.$patch({ json }), SettingsDto));

// ---------- Sources, refresh and matches ----------

export function useSources() {
  return useQuery({ queryKey: keys.sources, queryFn: () => unwrap(client.api.sources.$get(), SourceList) });
}

function useSourceMutation<I, O>(run: (input: I) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: run, onSettled: () => qc.invalidateQueries({ queryKey: keys.sources }) });
}

/** Add a company board from its careers link. The server checks the board before saving. */
export const useAddSource = () =>
  useSourceMutation((url: string) => unwrap(client.api.sources.$post({ json: { url } }), SourceDto));

export const useUpdateSource = () =>
  useSourceMutation(({ id, ...json }: { id: SourceId; enabled?: boolean; keywords?: string[] | null }) =>
    unwrap(client.api.sources[":id"].$patch({ param: { id }, json }), SourceDto),
  );

export const useDeleteSource = () =>
  useSourceMutation((id: SourceId) => unwrap(client.api.sources[":id"].$delete({ param: { id } }), SourceList));

// ---------- Matches ----------

/** The Matches list. The old list stays on screen while a new search or filter loads. */
export function useMatches(query: MatchQueryInput) {
  return useQuery({
    queryKey: keys.matchList(query),
    queryFn: () => unwrap(client.api.matches.$get({ query: matchQueryString(query) }), MatchList),
    placeholderData: keepPreviousData,
  });
}

/** Query strings carry only what is set. */
function matchQueryString(query: MatchQueryInput): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]])),
  );
}

const matchDetailQuery = (id: JobId) => ({
  queryKey: keys.match(id),
  queryFn: () => unwrap(client.api.matches[":id"].$get({ param: { id } }), MatchDetail),
});

/** The reading pane. It keeps showing the previous job until the next one arrives (section 4). */
export function useMatchDetail(id: JobId | null) {
  return useQuery({
    queryKey: id === null ? ["matches", "detail", "none"] : keys.match(id),
    queryFn: id === null ? skipToken : matchDetailQuery(id).queryFn,
    placeholderData: keepPreviousData,
  });
}

/** Load a job's pane before it is selected, so j and k land on a ready pane. */
export function usePrefetchMatch() {
  const qc = useQueryClient();
  return (id: JobId) => qc.prefetchQuery({ ...matchDetailQuery(id), staleTime: 30_000 });
}

/**
 * Save, dismiss and undo. The row leaves (or returns to) the list on the server's answer; the
 * page moves the selection itself, so the list never waits on the network to move on.
 */
function useMatchMutation<T, R>(fn: (input: T) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      Promise.all([qc.invalidateQueries({ queryKey: keys.matches }), qc.invalidateQueries({ queryKey: keys.board })]),
  });
}

export const useSaveJob = () =>
  useMatchMutation((id: JobId) => unwrap(client.api.jobs[":id"].save.$post({ param: { id } }), SavedJob));

export const useDismissJob = () =>
  useMatchMutation(({ id, reason }: { id: JobId; reason: DismissReason | null }) =>
    unwrap(
      client.api.jobs[":id"].dismiss.$post({ param: { id }, json: { reason } }),
      z.object({ ok: z.literal(true) }),
    ),
  );

/** Merge a job into a likely duplicate (section 3.8); the answer names the job that was kept. */
export const useMergeJob = () =>
  useMatchMutation(({ id, into }: { id: JobId; into: JobId }) =>
    unwrap(client.api.jobs[":id"].merge.$post({ param: { id }, json: { into } }), MergeResult),
  );

export const useUndoJob = () =>
  useMatchMutation(({ id, action }: { id: JobId; action: "save" | "dismiss" }) =>
    unwrap(client.api.jobs[":id"].undo.$post({ param: { id }, json: { action } }), z.object({ ok: z.literal(true) })),
  );

/** The newest refresh. Polls while it runs; the top bar shows its step. */
export function useRefresh() {
  return useQuery({
    queryKey: keys.refresh,
    queryFn: () => unwrap(client.api.refresh.$get(), RefreshDto),
    refetchInterval: (query) => (query.state.data?.task?.status === "running" ? TASK_POLL_MS : false),
  });
}

export function useStartRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(client.api.refresh.$post(), TaskDto),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.refresh }),
  });
}
