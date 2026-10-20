import { describe, expect, test } from "bun:test";
import { checkRoles, roleHeader } from "@/domain/work-roles";
import { bodyHtml } from "@/server/adapters/pdf";
import { COMMA_CV, COMMA_ROLES, PAREN_CV, PAREN_ROLES } from "./fixtures/roles-cv";

describe("checkRoles on whole CVs (decision 71)", () => {
  test("a title + dates line over a 'Company (Location)' line keeps every field", () => {
    expect(checkRoles({ text: PAREN_CV, roles: PAREN_ROLES })).toEqual(PAREN_ROLES);
  });

  test("a title + dates line over a 'COMPANY, LOCATION' line keeps every field", () => {
    expect(checkRoles({ text: COMMA_CV, roles: COMMA_ROLES })).toEqual(COMMA_ROLES);
  });

  test("a reworded date or a location from another CV is dropped, the role stays", () => {
    const [first] = PAREN_ROLES;
    if (!first) throw new Error("fixture has no roles");
    expect(checkRoles({ text: PAREN_CV, roles: [{ ...first, start: "January 2026", location: "MAKATI" }] })).toEqual([
      { ...first, start: null, location: null },
    ]);
  });
});

describe("bodyHtml role headers", () => {
  test("title and dates on one line, company and location below", () => {
    const [first] = PAREN_ROLES;
    if (!first) throw new Error("fixture has no roles");
    const html = bodyHtml(`## Experience\n${roleHeader(first)}\n- Built a billing service`);
    expect(html).toContain(
      '<div class="role"><p class="role-line"><strong class="role-title">Full-stack Software Engineer</strong><span class="role-dates">Jan, 2026 – Jun, 2026</span></p><p class="role-org">Lakbay Labs, Remote</p></div>',
    );
    expect(html).toContain("<ul><li>Built a billing service</li></ul>");
  });

  test("a header without dates has no dates span, and its text is escaped", () => {
    const html = bodyHtml("### <b>Engineer</b> | Acme & Co");
    expect(html).toBe(
      '<div class="entry"><div class="role"><p class="role-line"><strong class="role-title">&lt;b&gt;Engineer&lt;/b&gt;</strong></p><p class="role-org">Acme &amp; Co</p></div></div>',
    );
  });
});
