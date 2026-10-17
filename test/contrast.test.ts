import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/*
 * Craft floor (section 4): every text pair in the palette meets WCAG contrast in both themes.
 * Reads the OKLCH custom properties straight from styles.css, so a palette edit that drops a
 * pair below its floor fails here before anyone eyeballs a screenshot.
 */

const css = await Bun.file(join(import.meta.dir, "../src/web/styles.css")).text();

type Oklch = { l: number; c: number; h: number };

function readTheme(block: string): Map<string, Oklch> {
  const vars = new Map<string, Oklch>();
  for (const m of block.matchAll(/--([a-z-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
    const [, name, l, c, h] = m;
    if (name && l && c && h) vars.set(name, { l: Number(l), c: Number(c), h: Number(h) });
  }
  return vars;
}

const lightBlock = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
const darkBlock = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf("@theme inline"));
const light = readTheme(lightBlock);
// Dark overrides every color; anything it leaves out falls back to light, as the cascade does.
const dark = new Map([...light, ...readTheme(darkBlock)]);

/** OKLCH to linear sRGB (Björn Ottosson's matrices), clamped to the gamut. */
function toLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

function luminance(color: Oklch): number {
  const [r, g, b] = toLinearSrgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: Oklch, bg: Oklch): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [text, surface, floor]. 4.5 for body text; 3 for focus rings and non-text marks (WCAG 1.4.11). */
const PAIRS: [string, string, number][] = [
  ["foreground", "background", 4.5],
  ["foreground", "popover", 4.5],
  ["foreground", "selection", 4.5],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "muted", 4.5],
  ["muted-foreground", "secondary", 4.5],
  ["muted-foreground", "popover", 4.5],
  ["secondary-foreground", "secondary", 4.5],
  ["primary-foreground", "primary", 4.5],
  ["primary", "background", 4.5],
  ["accent-foreground", "accent", 4.5],
  // The selected Matches row is bg-accent; its company and meta lines stay muted.
  ["muted-foreground", "accent", 4.5],
  // Needs-input panels and placeholder marks sit on the warning surface.
  ["foreground", "warning-surface", 4.5],
  ["muted-foreground", "warning-surface", 4.5],
  ["destructive", "background", 4.5],
  ["warning-foreground", "warning-surface", 4.5],
  ["warning-foreground", "background", 4.5],
  ["ring", "background", 3],
  ["warning", "background", 3],
];

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("%s theme", (_name, theme) => {
  test.each(PAIRS)("%s on %s is at least %d:1", (fg, bg, floor) => {
    const text = theme.get(fg);
    const surface = theme.get(bg);
    if (!text || !surface) throw new Error(`missing --${text ? bg : fg}`);
    expect(contrast(text, surface)).toBeGreaterThanOrEqual(floor);
  });
});

test("the converter agrees with known values", () => {
  // White on black is the maximum, 21:1.
  expect(contrast({ l: 1, c: 0, h: 0 }, { l: 0, c: 0, h: 0 })).toBeCloseTo(21, 1);
});
