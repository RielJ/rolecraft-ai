import type { PanelReply, PanelRequest } from "../messages";
import { type Effect, INITIAL_STATE, type PanelEvent, type PanelState, replyToEvent, transition } from "./state";

function sessionId(state: PanelState) {
  switch (state.session.kind) {
    case "claimed":
      return state.session.work.session.id;
    case "available":
      return state.session.session.id;
    case "loading":
    case "none":
    case "failed":
      return null;
    default: {
      const exhaustive: never = state.session;
      return exhaustive;
    }
  }
}

/** One owner for panel state, worker replies and delayed task polls. */
export function createPanelMachine({
  send,
  onReply,
  onState,
}: {
  send: (request: PanelRequest) => Promise<PanelReply>;
  onReply: (reply: PanelReply) => void;
  onState: (state: PanelState) => void;
}) {
  const current = { current: INITIAL_STATE };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let live = true;
  let epoch = 0;
  let discovery = 0;

  const ask = async (request: PanelRequest): Promise<PanelReply> => {
    const startedIn = epoch;
    const discoveryId = request.kind === "session_active" ? ++discovery : null;
    const tabUrl = current.current.tab?.url;
    const reply = await send(request);
    // A previous job or mount cannot update this application, even with session_expired.
    if (!live || startedIn !== epoch || (discoveryId !== null && discoveryId !== discovery)) return reply;
    if (
      request.kind === "scan" &&
      (request.tabId !== current.current.tab?.tabId || tabUrl !== current.current.tab?.url)
    )
      return reply;
    onReply(reply);
    dispatch(replyToEvent({ request, reply }));
    return reply;
  };
  const run = ({ request, delayMs }: Effect) => {
    if (delayMs === 0) {
      void ask(request);
      return;
    }
    const scheduledIn = epoch;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (live && scheduledIn === epoch) void ask(request);
    }, delayMs);
    timers.add(timer);
  };
  const dispatch = (event: PanelEvent) => {
    const out = transition(current.current, event);
    if (event.kind === "opened" || sessionId(current.current) !== sessionId(out.state)) epoch++;
    current.current = out.state;
    onState(out.state);
    for (const effect of out.effects) run(effect);
  };

  return {
    current,
    dispatch,
    ask,
    start: () => {
      live = true;
    },
    stop: () => {
      live = false;
      epoch++;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
