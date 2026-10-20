# Skip posting boilerplate when reading skills

- **Status:** frozen
- **Area:** Matching

## Problem

Skills are read from the whole posting. Sections like About us, Benefits and the EEO statement name tools and words that are not requirements, so they can count as required skills (decision 76) and lower the skill percentage.

## Evidence

`docs/ARCHITECTURE.md`, "Planned, not built". `src/domain/skill-sections.ts` already splits nice-to-have text from required text, but treats boilerplate as required.

## Pull into scope when

Matches during the MVP rank good jobs low, or bad ones high, because of skills named in boilerplate.

## Acceptance

- Text under About us, Benefits, Perks and EEO headings is not read for skills.
- `skill-sections.test.ts` covers each heading with a real posting excerpt.
- Stored jobs are re-read so the change applies to existing matches.
