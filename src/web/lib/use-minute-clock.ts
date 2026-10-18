import { useEffect, useState } from "react";

/** The time now, moved on once a minute, so relative labels ("5 minutes ago") age without a reload. */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
