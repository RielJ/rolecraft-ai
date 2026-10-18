import { useSyncExternalStore } from "react";

/** Whether a CSS media query matches now, updated as it changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Tailwind's `md` breakpoint: the list and the job show side by side from here up. */
export const useIsWide = () => useMediaQuery("(min-width: 48rem)");
