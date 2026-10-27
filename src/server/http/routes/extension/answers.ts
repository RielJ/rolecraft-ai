import { Hono } from "hono";
import { z } from "zod";
import type { ExtensionEnv } from "@/server/http/extension-guard";
import { validate } from "@/server/http/validate";
import type { Deps } from "@/server/services/context";
import {
  createSessionQuestion,
  saveSessionAnswerReference,
  sessionQuestionAnswers,
} from "@/server/services/extension-answers";
import { ApplicationSessionId } from "@/shared/extension";
import { CreateQuestionInput, QuestionLookupInput, SaveAnswerReferenceInput } from "@/shared/extension-answers";

const SessionParam = z.object({ id: ApplicationSessionId });

/** Explicit custom-question actions, behind the same pairing guard as prefill and drafting. */
export function extensionAnswerRoutes(deps: Deps) {
  return new Hono<ExtensionEnv>()
    .post(
      "/sessions/:id/questions/lookup",
      validate("param", SessionParam),
      validate("json", QuestionLookupInput),
      async (c) =>
        c.json(
          await sessionQuestionAnswers(deps, {
            sessionId: c.req.valid("param").id,
            pairingId: c.get("pairing").id,
            input: c.req.valid("json"),
          }),
        ),
    )
    .post(
      "/sessions/:id/questions",
      validate("param", SessionParam),
      validate("json", CreateQuestionInput),
      async (c) =>
        c.json(
          await createSessionQuestion(deps, {
            sessionId: c.req.valid("param").id,
            pairingId: c.get("pairing").id,
            input: c.req.valid("json"),
          }),
        ),
    )
    .post(
      "/sessions/:id/answer-references",
      validate("param", SessionParam),
      validate("json", SaveAnswerReferenceInput),
      async (c) =>
        c.json(
          await saveSessionAnswerReference(deps, {
            sessionId: c.req.valid("param").id,
            pairingId: c.get("pairing").id,
            input: c.req.valid("json"),
          }),
        ),
    );
}
