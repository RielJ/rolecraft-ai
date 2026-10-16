import { Hono } from "hono";
import { z } from "zod";
import { FactId, PasteCvInput, UpdateFactInput, UpdateProfileInput } from "@/shared/api";
import type { Deps } from "../../services/context";
import {
  confirmAllFacts,
  confirmFact,
  deleteFact,
  getProfile,
  pasteCv,
  updateFact,
  updateProfile,
} from "../../services/profile";
import { validate } from "../validate";

const FactParam = z.object({ id: FactId });

export function profileRoutes(deps: Deps) {
  return new Hono()
    .get("/profile", async (c) => c.json(await getProfile(deps)))
    .put("/profile", validate("json", UpdateProfileInput), async (c) =>
      c.json(await updateProfile(deps, c.req.valid("json"))),
    )
    .put("/profile/cv", validate("json", PasteCvInput), async (c) => c.json(await pasteCv(deps, c.req.valid("json"))))
    .post("/facts/confirm-all", async (c) => c.json(await confirmAllFacts(deps)))
    .post("/facts/:id/confirm", validate("param", FactParam), async (c) =>
      c.json(await confirmFact(deps, { factId: c.req.valid("param").id })),
    )
    .patch("/facts/:id", validate("param", FactParam), validate("json", UpdateFactInput), async (c) =>
      c.json(await updateFact(deps, { factId: c.req.valid("param").id, ...c.req.valid("json") })),
    )
    .delete("/facts/:id", validate("param", FactParam), async (c) =>
      c.json(await deleteFact(deps, { factId: c.req.valid("param").id })),
    );
}
