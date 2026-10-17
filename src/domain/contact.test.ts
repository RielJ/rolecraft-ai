import { describe, expect, test } from "bun:test";
import type { Contact } from "@/shared/api";
import { contactFromCv, fillContact } from "./contact";

const HEADER = [
  "Juan Dela Cruz",
  "+63 917 555 0199 • juan.delacruz@example.com • Cebu City",
  "https://github.com/juandelacruz",
  "https://juandelacruz.dev",
  "Summary",
  "Senior Full-stack Engineer with over 5 years of experience building Node.js and ASP.NET services.",
  "Work Experience",
  "Full-stack Software Engineer January 2026 – June 2026",
].join("\n");

describe("contactFromCv", () => {
  test("reads the name, phone, email, location and links of a typical header, verbatim", () => {
    expect(contactFromCv(HEADER)).toEqual({
      fullName: "Juan Dela Cruz",
      email: "juan.delacruz@example.com",
      phone: "+63 917 555 0199",
      location: "Cebu City",
      links: ["https://github.com/juandelacruz", "https://juandelacruz.dev"],
    });
  });

  test("takes bare profile links and www links, and trims trailing punctuation", () => {
    const cv = "Ana Cruz\nana@cruz.dev | linkedin.com/in/anacruz | www.anacruz.dev, github.com/anacruz.\nEXPERIENCE";
    expect(contactFromCv(cv).links).toEqual(["linkedin.com/in/anacruz", "www.anacruz.dev", "github.com/anacruz"]);
  });

  test("never reads tech names, dates or email domains as links or phones", () => {
    const cv = ["Ana Cruz", "Engineer · Node.js · Next.js · ASP.NET", "ana@cruz.dev", "2018-2020 · 2021 – 2024"].join(
      "\n",
    );
    const found = contactFromCv(cv);
    expect(found.links).toEqual([]);
    expect(found.phone).toBe("");
    expect(found.location).toBe("");
  });

  test("leaves the name empty when the first line is a title, not a name", () => {
    expect(contactFromCv("CURRICULUM VITAE\nAna Cruz").fullName).toBe("");
    expect(contactFromCv("Resume\nAna Cruz").fullName).toBe("");
    expect(contactFromCv("Backend Engineer with 5 years in Go\nAna Cruz").fullName).toBe("");
    expect(contactFromCv("MARIA DE LA CRUZ\nmaria@x.ph").fullName).toBe("MARIA DE LA CRUZ");
  });

  test("only reads the header: contact details deep in the body are not the user's", () => {
    const body = Array.from({ length: 12 }, (_, i) => `- Built thing ${i}`).join("\n");
    const cv = `Ana Cruz\n${body}\nReferences: Ben Uy, ben@uy.ph, +63 917 555 0101, https://uy.ph`;
    expect(contactFromCv(cv)).toEqual({ fullName: "Ana Cruz", email: "", phone: "", location: "", links: [] });
  });

  test("a CV with no header finds nothing", () => {
    expect(contactFromCv("- Built a billing service\n- Led 3 engineers")).toEqual({
      fullName: "",
      email: "",
      phone: "",
      location: "",
      links: [],
    });
  });
});

describe("fillContact", () => {
  const empty: Contact = { fullName: "", email: "", phone: "", location: "Philippines", links: [] };
  const found = contactFromCv(HEADER);

  test("fills every empty field, and keeps the country when the default stands", () => {
    expect(fillContact(empty, found)).toEqual({
      contact: { ...found, location: "Cebu City, Philippines" },
      filled: ["fullName", "email", "phone", "location", "links"],
    });
  });

  test("never overwrites what the user typed", () => {
    const typed: Contact = {
      fullName: "Riel B.",
      email: "me@work.ph",
      phone: "",
      location: "Cebu City",
      links: ["https://x.dev"],
    };
    expect(fillContact(typed, found)).toEqual({ contact: { ...typed, phone: "+63 917 555 0199" }, filled: ["phone"] });
  });

  test("a CV location that already names the country is kept as is", () => {
    const cv = "Ana Cruz\nana@cruz.dev • Davao City, Philippines";
    expect(fillContact(empty, contactFromCv(cv)).contact.location).toBe("Davao City, Philippines");
  });

  test("nothing found changes nothing", () => {
    expect(fillContact(empty, contactFromCv("- Built things"))).toEqual({ contact: empty, filled: [] });
  });
});
