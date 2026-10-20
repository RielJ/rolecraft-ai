import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  AddonInput,
  AddReposInput,
  type ApiErrorBody,
  ConfirmOverCapInput,
  FactId,
  ItemId,
  MAX_CV_BYTES,
  PasteCvInput,
  SaveRolesInput,
  SetSkillInput,
  UpdateFactInput,
  UpdateProfileInput,
  UploadCvForm,
} from "@/shared/api";
import { AppError, type Deps } from "../../services/context";
import { addGithubRepos, readGithub, scanGithubRepos } from "../../services/github";
import {
  confirmAllFacts,
  confirmFact,
  createAddon,
  deleteAddon,
  deleteFact,
  getProfile,
  keepFact,
  readCvFile,
  readItemRoles,
  saveCv,
  saveItemRoles,
  setSkill,
  updateAddon,
  updateFact,
  updateProfile,
  uploadCv,
} from "../../services/profile";
import { inlineDisposition } from "../disposition";
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
  return (
    new Hono()
      .get("/profile", async (c) => c.json(await getProfile(deps)))
      .put("/profile", validate("json", UpdateProfileInput), async (c) =>
        c.json(await updateProfile(deps, c.req.valid("json"))),
      )
      .put("/profile/skills", validate("json", SetSkillInput), async (c) =>
        c.json(await setSkill(deps, c.req.valid("json"))),
      )
      .put("/profile/cv", validate("json", PasteCvInput), async (c) => c.json(await saveCv(deps, c.req.valid("json"))))
      // The kept PDF, shown in an iframe on the Profile page (decision 69). localGuard checks Origin
      // only on writes, so this read refuses cross-site requests itself: another site may not embed
      // or fetch the CV. The type is a constant, and nosniff stops a browser guessing another one.
      // No `sandbox` CSP: Chrome's PDF viewer refuses to render under one.
      .get("/profile/cv/file", async (c) => {
        if (c.req.header("sec-fetch-site") === "cross-site") {
          throw new AppError({ code: "forbidden_origin", message: "Another site may not read your CV." });
        }
        const { fileName, data } = await readCvFile(deps);
        return c.body(data.slice().buffer, 200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": inlineDisposition(fileName),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Frame-Options": "SAMEORIGIN",
        });
      })
      .post("/profile/cv/file", uploadLimit, validate("form", UploadCvForm), async (c) => {
        const { file, confirmOverCap } = c.req.valid("form");
        const bytes = new Uint8Array(await file.arrayBuffer());
        return c.json(await uploadCv(deps, { fileName: file.name, bytes, confirmOverCap: confirmOverCap === "true" }));
      })
      // Finding the user's own repos through gh (decision 78).
      .get("/profile/github/repos", async (c) => c.json(await scanGithubRepos(deps)))
      .post("/profile/github/repos", validate("json", AddReposInput), async (c) =>
        c.json(await addGithubRepos(deps, c.req.valid("json"))),
      )
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
      // Roles of the CV or an experience add-on (decision 71).
      .post(
        "/profile/items/:id/roles/read",
        validate("param", ItemParam),
        validate("json", ConfirmOverCapInput),
        async (c) =>
          c.json(
            await readItemRoles(deps, {
              itemId: c.req.valid("param").id,
              confirmOverCap: c.req.valid("json").confirmOverCap,
            }),
          ),
      )
      .put("/profile/items/:id/roles", validate("param", ItemParam), validate("json", SaveRolesInput), async (c) =>
        c.json(await saveItemRoles(deps, { itemId: c.req.valid("param").id, ...c.req.valid("json") })),
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
      )
  );
}
