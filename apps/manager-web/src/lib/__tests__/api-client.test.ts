import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, fetchMeta, fetchHealth } from "../api-client";

describe("api-client", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("builds against the generated @ultrakil/api-contracts types without error", () => {
    // Importing this module already exercises `paths` from the generated
    // contract at the type level. This assertion just confirms the module
    // loads and exports the expected functions at runtime.
    expect(typeof fetchMeta).toBe("function");
    expect(typeof fetchHealth).toBe("function");
  });

  it("rejects with an ApiError carrying the backend's stable code on a non-2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ code: "QUEUE_UNAVAILABLE", message: "Cannot reach Redis." }),
    }) as unknown as typeof fetch;

    await expect(fetchMeta()).rejects.toMatchObject({
      code: "QUEUE_UNAVAILABLE",
      message: "Cannot reach Redis.",
    });
  });

  it("rejects with a NETWORK_UNAVAILABLE ApiError when the request itself fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;

    await expect(fetchMeta()).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  });

  it("ApiError is a real Error instance, so it works with standard error handling", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("boom")) as unknown as typeof fetch;

    await expect(fetchMeta()).rejects.toBeInstanceOf(ApiError);
    await expect(fetchMeta()).rejects.toBeInstanceOf(Error);
  });
});
