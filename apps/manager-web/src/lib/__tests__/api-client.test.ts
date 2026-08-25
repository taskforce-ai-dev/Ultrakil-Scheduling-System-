import { describe, expect, it } from "vitest";

import { fetchMeta, fetchHealth } from "../api-client";

describe("api-client", () => {
  it("builds against the generated @ultrakil/api-contracts types without error", () => {
    // Importing this module already exercises `paths` from the generated
    // contract at the type level. This assertion just confirms the module
    // loads and exports the expected functions at runtime.
    expect(typeof fetchMeta).toBe("function");
    expect(typeof fetchHealth).toBe("function");
  });
});
