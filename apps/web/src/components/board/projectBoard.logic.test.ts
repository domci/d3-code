import { describe, expect, it } from "vite-plus/test";

import { repositoryAccent } from "./projectBoard.logic";

describe("repositoryAccent", () => {
  it("is stable and case-insensitive", () => {
    expect(repositoryAccent("Acme/Web")).toBe(repositoryAccent("acme/web"));
  });
});
