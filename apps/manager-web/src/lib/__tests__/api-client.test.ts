import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, fetchMeta, fetchHealth, fetchVisitAssignment } from "../api-client";

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

  it("resolves to undefined on a 200 with a genuinely empty body, rather than throwing", async () => {
    // Real example: GET /visits/:id/assignment for an unassigned visit comes
    // back 200 with a zero-length body instead of 204 or a JSON `null` —
    // Response.json() rejects on empty input, and an uncaught parse error
    // isn't an ApiError, so this used to surface as an unexplained
    // "Something went wrong" instead of "no assignment".
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
    }) as unknown as typeof fetch;

    await expect(fetchMeta()).resolves.toBeUndefined();
  });

  it("fetchVisitAssignment resolves to null, not undefined, when a visit has no assignment", async () => {
    // A visit with no assignment yet gets a 204, which `request` resolves to
    // `undefined` (see the test above). Every caller of fetchVisitAssignment
    // compares the result against `null` (e.g. the crew editor's
    // `assignment !== null` publication-history check), and `undefined !==
    // null` is true in JS — an unnormalised `undefined` here slipped past
    // that guard and crashed the drawer on any visit with no assignment.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    }) as unknown as typeof fetch;

    await expect(fetchVisitAssignment("visit-1")).resolves.toBeNull();
  });
});
