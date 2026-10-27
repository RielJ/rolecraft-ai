import { describe, expect, test } from "bun:test";
import { ApplicationSessionDto, PairingId } from "@shared/extension";
import type { PanelReply, PanelRequest } from "../src/messages";
import { createPanelMachine } from "../src/panel/machine";

const session = ApplicationSessionDto.parse({
  id: "0b8f1d9e-3c2a-4e5f-8a7b-6c5d4e3f2a1b",
  opportunityId: "4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d",
  status: "pending",
  applyUrl: "https://boards.example/jobs/1",
  applyUrlKey: "boards.example/jobs/1",
  title: "Engineer",
  company: "Acme",
  createdAt: "2026-10-18T03:00:00.000Z",
  expiresAt: "2026-10-18T04:00:00.000Z",
  claimedAt: null,
});
const next = ApplicationSessionDto.parse({
  ...session,
  id: "1c9f2e0f-4d3b-4f60-9b8c-7d6e5f4a3b2c",
  company: "Next Company",
});
const status: PanelReply["status"] = {
  kind: "paired",
  endpoint: "http://localhost:3000",
  pairingId: PairingId.parse(session.id),
};

function setup() {
  const pending: { request: PanelRequest; promise: Promise<PanelReply>; resolve: (reply: PanelReply) => void }[] = [];
  const machine = createPanelMachine({
    send: (request) => {
      const reply = Promise.withResolvers<PanelReply>();
      pending.push({ request, promise: reply.promise, resolve: reply.resolve });
      return reply.promise;
    },
    onReply: () => {},
    onState: () => {},
  });
  const answer = async (index: number, result: PanelReply["result"]) => {
    const call = pending[index];
    if (call === undefined) throw new Error(`No request ${index}`);
    call.resolve({ status, error: null, ...(result === undefined ? {} : { result }) });
    await call.promise;
  };
  machine.dispatch({ kind: "opened", tab: { tabId: 7, url: session.applyUrl } });
  return { machine, pending, answer };
}

describe("panel request lifecycle", () => {
  test("a slow discovery cannot replace a newer discovery and claimed job", async () => {
    const { machine, answer } = setup();
    machine.dispatch({ kind: "refresh" });
    await answer(1, { kind: "session_active", active: { kind: "active", session: next } });
    await answer(2, { kind: "claimed", session: next });
    await answer(0, { kind: "session_active", active: { kind: "active", session } });
    expect(machine.current.current.session).toMatchObject({ kind: "claimed", work: { session: { id: next.id } } });
    machine.stop();
  });

  test("an old job's late session_expired response cannot clear the new job", async () => {
    const { machine, answer } = setup();
    await answer(0, { kind: "session_active", active: { kind: "active", session } });
    await answer(1, { kind: "claimed", session });
    // The old job's outputs request remains in flight while a new Apply is discovered.
    machine.dispatch({ kind: "refresh" });
    await answer(3, { kind: "session_active", active: { kind: "active", session: next } });
    await answer(4, { kind: "claimed", session: next });
    await answer(2, { kind: "failed", code: "session_expired", message: "Old session expired" });
    expect(machine.current.current.session).toMatchObject({ kind: "claimed", work: { session: { id: next.id } } });
    machine.stop();
  });

  test("restarting after cleanup ignores the previous mount's in-flight reply", async () => {
    const { machine, answer } = setup();
    machine.stop();
    machine.start();
    machine.dispatch({ kind: "opened", tab: { tabId: 7, url: session.applyUrl } });
    await answer(1, { kind: "session_active", active: { kind: "none" } });
    await answer(0, { kind: "session_active", active: { kind: "active", session } });
    expect(machine.current.current.session).toEqual({ kind: "none" });
    machine.stop();
  });
});
