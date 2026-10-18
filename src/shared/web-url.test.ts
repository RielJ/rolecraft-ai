import { describe, expect, test } from "bun:test";
import { webUrl } from "./web-url";

describe("webUrl", () => {
  test.each([
    ["https://jobs.lever.co/acme/123/apply", "https://jobs.lever.co/acme/123/apply"],
    ["http://example.com/jobs?id=1", "http://example.com/jobs?id=1"],
    ["HTTPS://Boards.Greenhouse.io/acme", "https://boards.greenhouse.io/acme"],
  ])("keeps %s", (raw, expected) => {
    expect(webUrl(raw)).toBe(expected);
  });

  test.each([
    "javascript:alert(1)",
    " JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/jobs/123",
    "jobs.lever.co/acme",
    "",
  ])("refuses %p", (raw) => {
    expect(webUrl(raw)).toBeNull();
  });
});
