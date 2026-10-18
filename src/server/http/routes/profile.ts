import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  AddonInput,
  type ApiErrorBody,
  ConfirmOverCapInput,
  FactId,
  ItemId,
  MAX_CV_BYTES,
  PasteCvInput,
  SetSkillInput,
  UpdateFactInput,
  UpdateProfileInput,
  UploadCvForm,
} from "@/shared/api";
import type { Deps } from "../../services/context";
import { readGithub } from "../../services/github";
import {
  confirmAllFacts,
  confirmFact,
  createAddon,
  deleteAddon,
  deleteFact,
  getProfile,
  keepFact,
  saveCv,
  setSkill,
  updateAddon,
  updateFact,
  updateProfile,
  uploadCv,
} from "../../services/profile";
import { validate } from "../validate";

const FactParam = z.object({ id: FactId });
const ItemParam = z.object({ id: ItemId });

/** The multipart envelope may add a little on top of the file itself. */
const uploadLimit = bodyLimit({
  maxSize: MAX_CV_BYTES + 64 * 1024,
  onError: (c) => {
    const body: ApiErrorBody = {
      error: { code: "invalid_input", message: "That file is over 10 MB. Save a smaller copy, or paste the text." },
    };
    return c.json(body, 400);
  },
});

export function profileRoutes(deps: Deps) {
  return new Hono()
    .get("/profile", async (c) => c.json(await getProfile(deps)))
    .put("/profile", validate("json", UpdateProfileInput), async (c) =>
      c.json(await updateProfile(deps, c.req.valid("json"))),
    )
    .put("/profile/skills", validate("json", SetSkillInput), async (c) =>
      c.json(await setSkill(deps, c.req.valid("json"))),
    )
    .put("/profile/cv", validate("json", PasteCvInput), async (c) => c.json(await saveCv(deps, c.req.valid("json"))))
    .post("/profile/cv/file", uploadLimit, validate("form", UploadCvForm), async (c) => {
      const { file, confirmOverCap } = c.req.valid("form");
      const bytes = new Uint8Array(await file.arrayBuffer());
      return c.json(await uploadCv(deps, { fileName: file.name, bytes, confirmOverCap: confirmOverCap === "true" }));
    })
    .post("/profile/addons", validate("json", AddonInput), async (c) =>
      c.json(await createAddon(deps, c.req.valid("json")), 201),
    )
    .put("/profile/addons/:id", validate("param", ItemParam), validate("json", AddonInput), async (c) =>
      c.json(await updateAddon(deps, { itemId: c.req.valid("param").id, ...c.req.valid("json") })),
    )
    .post(
      "/profile/addons/:id/github-read",
      validate("param", ItemParam),
      validate("json", ConfirmOverCapInput),
      async (c) =>
        c.json(
          await readGithub(deps, {
            itemId: c.req.valid("param").id,
            confirmOverCap: c.req.valid("json").confirmOverCap,
          }),
        ),
    )
    .delete("/profile/addons/:id", validate("param", ItemParam), async (c) =>
      c.json(await deleteAddon(deps, { itemId: c.req.valid("param").id })),
    )
    .post("/facts/confirm-all", async (c) => c.json(await confirmAllFacts(deps)))
    .post("/facts/:id/confirm", validate("param", FactParam), async (c) =>
      c.json(await confirmFact(deps, { factId: c.req.valid("param").id })),
    )
    .post("/facts/:id/keep", validate("param", FactParam), async (c) =>
      c.json(await keepFact(deps, { factId: c.req.valid("param").id })),
    )
    .patch("/facts/:id", validate("param", FactParam), validate("json", UpdateFactInput), async (c) =>
      c.json(await updateFact(deps, { factId: c.req.valid("param").id, ...c.req.valid("json") })),
    )
    .delete("/facts/:id", validate("param", FactParam), async (c) =>
      c.json(await deleteFact(deps, { factId: c.req.valid("param").id })),
    );
}
