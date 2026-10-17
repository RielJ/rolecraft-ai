import { Hono } from "hono";
import { z } from "zod";
import { JobId, MatchQuery } from "@/shared/api";
import type { Deps } from "../../services/context";
import { listMatches, matchDetail } from "../../services/matches";
import { validate } from "../validate";

export function matchRoutes(deps: Deps) {
  return new Hono()
    .get("/matches", validate("query", MatchQuery), async (c) => c.json(await listMatches(deps, c.req.valid("query"))))
    .get("/matches/:id", validate("param", z.object({ id: JobId })), async (c) =>
      c.json(await matchDetail(deps, c.req.valid("param").id)),
    );
}
