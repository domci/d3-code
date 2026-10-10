import { expect, it } from "vite-plus/test";

import { parseSuggestedTask } from "./SuggestedTaskCard";

it("parses a complete task and defaults the summary", () => {
  expect(
    parseSuggestedTask('{"title":"Fix docs","summary":"Stale.","prompt":"Update README.md"}'),
  ).toEqual({ title: "Fix docs", summary: "Stale.", prompt: "Update README.md" });
  expect(parseSuggestedTask('{"title":"Fix docs","prompt":"Update README.md"}')?.summary).toBe("");
});

it("rejects invalid JSON, non-objects, and missing or blank fields", () => {
  expect(parseSuggestedTask('{"title":"Fix docs","summ')).toBeNull();
  expect(parseSuggestedTask("[1]")).toBeNull();
  expect(parseSuggestedTask('{"title":"Fix docs","summary":"Stale."}')).toBeNull();
  expect(parseSuggestedTask('{"title":"  ","prompt":"Update README.md"}')).toBeNull();
});
