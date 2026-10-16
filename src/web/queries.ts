import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  AddJobResult,
  type AddonInput,
  BoardItemDto,
  type DraftInput,
  type FactId,
  type ItemId,
  type OpportunityId,
  type OutputId,
  type PasteJobInput,
  ProfileDto,
  type SaveAiKeyInput,
  SettingsDto,
  TaskDto,
  type TaskId,
  TextExport,
  type UpdateOutputInput,
  type UpdateProfileInput,
  type UpdateSettingsInput,
  WorkspaceDto,
} from "@/shared/api";
import { client, toApiError, unwrap } from "./api";

export const keys = {
  profile: ["profile"] as const,
  board: ["board"] as const,
  workspace: (id: OpportunityId) => ["workspace", id] as const,
  settings: ["settings"] as const,
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

export function useAddPastedJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (json: PasteJobInput) => unwrap(client.api.jobs["from-paste"].$post({ json }), AddJobResult),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.board }),
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
    },
  });
}

export const useSaveAiKey = () =>
  useSettingsMutation((json: SaveAiKeyInput) => unwrap(client.api.settings["ai-key"].$put({ json }), SettingsDto));

export const useRemoveAiKey = () =>
  useSettingsMutation(() => unwrap(client.api.settings["ai-key"].$delete(), SettingsDto));

export const useUpdateSettings = () =>
  useSettingsMutation((json: UpdateSettingsInput) => unwrap(client.api.settings.$patch({ json }), SettingsDto));
