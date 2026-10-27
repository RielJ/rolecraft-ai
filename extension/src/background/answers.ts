import type { z } from "zod";
import type { PanelResult } from "../messages";
import { type ReadAnswerRequest, ReadAnswerResult } from "../messages-answers";
import { type ContentDeps, checkTab } from "./content";

export type SendAnswer = (tabId: number, message: z.infer<typeof ReadAnswerRequest>) => Promise<unknown>;
export const chromeSendAnswer: SendAnswer = (tabId, message) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 });

/** The live session was checked by panel.ts before this reads a single, explicitly selected control. */
export async function readTabAnswer({
  deps,
  send,
  tabId,
  message,
}: {
  deps: Pick<ContentDeps, "getTab" | "store">;
  send: SendAnswer;
  tabId: number;
  message: z.infer<typeof ReadAnswerRequest>;
}): Promise<PanelResult> {
  const refusal = await checkTab({ deps, tabId });
  if (refusal !== null) return { kind: "refused", reason: refusal };
  const binding = await deps.store.readBinding();
  if (binding === null || binding.tabId !== tabId) return { kind: "refused", reason: "not_bound" };
  const raw = await send(tabId, message).catch(() => undefined);
  const reply = ReadAnswerResult.safeParse(raw);
  if (!reply.success || reply.data.nonce !== message.nonce || reply.data.fieldId !== message.field.fieldId) {
    return { kind: "refused", reason: "bad_reply" };
  }
  if (reply.data.kind === "answer_unavailable") {
    return {
      kind: "failed",
      code: "invalid_input",
      message: "This field changed or cannot be read. Scan the form again.",
    };
  }
  return { kind: "answer_read", fieldId: reply.data.fieldId, body: reply.data.body };
}
