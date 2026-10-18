import { z } from "zod";

// MV3 pages and the worker forbid eval. Zod would probe `new Function` on first parse, and Chrome
// reports the blocked probe as a CSP violation even though Zod catches it. Import this first in
// every entry point.
z.config({ jitless: true });
