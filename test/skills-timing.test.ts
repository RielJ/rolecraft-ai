import { expect, test } from "bun:test";
import { compileSkills, extractSkills } from "@/domain/features";
import { CUSTOM_SKILLS, skillTexts } from "./fixtures/skill-texts";

// Decision 66: Refresh reads every open job's skills again. With no database, reading 1,250
// postings of 8 KB with 20 skills of the user's own must stay well under the 2 s budget of the
// whole step; this fails only past 5 s, so a slow machine does not flake it.
test("extractSkills reads 1,250 texts of 8 KB with 20 custom skills in under 5 s", () => {
  const texts = skillTexts({ count: 1250, bytes: 8192 });
  const dict = compileSkills(CUSTOM_SKILLS);
  const started = performance.now();
  let found = 0;
  for (const text of texts) found += extractSkills(text, dict).length;
  const ms = performance.now() - started;
  console.log(JSON.stringify({ msg: "extractSkills timing", texts: texts.length, custom: CUSTOM_SKILLS.length, ms }));
  expect(found).toBeGreaterThan(0);
  expect(ms).toBeLessThan(5000);
});
