import { toast } from "sonner";
import { ApiError, errorMessage } from "../api";
import { useStartRefresh } from "../queries";

// The refresh this tab started, so its finish is announced once. A module store, not component
// state: the top bar and the setup checklist's sources panel both start refreshes, and only the
// top bar's button announces them. Set on the POST's answer, because a quick refresh can be done
// before the next poll would ever show it running.
let watched: string | null = null;
const watchListeners = new Set<() => void>();

export function setWatched(id: string | null): void {
  watched = id;
  for (const listener of watchListeners) listener();
}

export const watchedTask = (): string | null => watched;

export function subscribeWatched(listener: () => void) {
  watchListeners.add(listener);
  return () => watchListeners.delete(listener);
}

/** Start a refresh from anywhere; the top bar shows its step and sums it up when it ends. */
export function useRunRefresh(): {
  run: (options?: { onStarted?: (() => void) | undefined }) => void;
  pending: boolean;
} {
  const start = useStartRefresh();
  return {
    pending: start.isPending,
    run: (options) =>
      start.mutate(undefined, {
        onSuccess: (started) => {
          setWatched(started.id);
          options?.onStarted?.();
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === "refresh_running") toast("A refresh is already running.");
          else toast.error(errorMessage(error));
        },
      }),
  };
}
