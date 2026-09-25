import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, fetchCustomers: vi.fn() };
});

import { fetchCustomers, type Customer } from "@/lib/api-client";
import {
  CUSTOMER_PAGE_SIZE,
  IncompleteCustomerListError,
  loadAllCustomers,
} from "@/lib/load-all-customers";
import { buildCustomer } from "@/test/fixtures";

/** `count` customers named so the nth is identifiable by name alone. */
function customerRange(from: number, count: number): Customer[] {
  return Array.from({ length: count }, (_, index) =>
    buildCustomer({ id: `customer-${from + index}`, name: `Customer ${from + index}` }),
  );
}

/** Serves a list of `total` customers in pages, the way the API does. */
function servePages(total: number) {
  vi.mocked(fetchCustomers).mockImplementation(async (query) => {
    const page = query?.page ?? 1;
    const pageSize = query?.pageSize ?? CUSTOMER_PAGE_SIZE;
    const start = (page - 1) * pageSize;
    return {
      items: customerRange(start + 1, Math.max(0, Math.min(pageSize, total - start))),
      total,
      page,
      pageSize,
    };
  });
}

beforeEach(() => {
  vi.mocked(fetchCustomers).mockReset();
});

describe("loadAllCustomers", () => {
  it("returns a single page unchanged", async () => {
    servePages(3);
    const customers = await loadAllCustomers();
    expect(customers).toHaveLength(3);
    expect(vi.mocked(fetchCustomers)).toHaveBeenCalledTimes(1);
  });

  it("walks past the first page so customer 201 is included", async () => {
    servePages(250);
    const customers = await loadAllCustomers();

    expect(customers).toHaveLength(250);
    // The defect this exists to stop: a selector that asked once and stopped.
    expect(customers.map((customer) => customer.name)).toContain("Customer 201");
    expect(customers.at(-1)?.name).toBe("Customer 250");
    expect(vi.mocked(fetchCustomers)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchCustomers)).toHaveBeenNthCalledWith(1, { page: 1, pageSize: 200 });
    expect(vi.mocked(fetchCustomers)).toHaveBeenNthCalledWith(2, { page: 2, pageSize: 200 });
  });

  it("asks the API for the largest page it allows", async () => {
    servePages(10);
    await loadAllCustomers();
    expect(vi.mocked(fetchCustomers)).toHaveBeenCalledWith({ page: 1, pageSize: 200 });
    expect(CUSTOMER_PAGE_SIZE).toBe(200);
  });

  it("passes a caller's filter through to every page", async () => {
    servePages(250);
    await loadAllCustomers({ active: false });
    expect(vi.mocked(fetchCustomers)).toHaveBeenNthCalledWith(1, {
      active: false,
      page: 1,
      pageSize: 200,
    });
    expect(vi.mocked(fetchCustomers)).toHaveBeenNthCalledWith(2, {
      active: false,
      page: 2,
      pageSize: 200,
    });
  });

  it("refuses a partial list rather than returning a short one", async () => {
    // The server claims 500 but stops serving rows after the first page.
    vi.mocked(fetchCustomers).mockImplementation(async (query) => ({
      items: (query?.page ?? 1) === 1 ? customerRange(1, 200) : [],
      total: 500,
      page: query?.page ?? 1,
      pageSize: 200,
    }));

    await expect(loadAllCustomers()).rejects.toBeInstanceOf(IncompleteCustomerListError);
    await expect(loadAllCustomers()).rejects.toMatchObject({
      code: "CUSTOMER_LIST_INCOMPLETE",
      details: { loaded: 200, expected: 500 },
    });
  });

  it("refuses a looping server instead of paging forever", async () => {
    // Every page returns the same rows — paging is not advancing.
    vi.mocked(fetchCustomers).mockResolvedValue({
      items: customerRange(1, 200),
      total: 500,
      page: 1,
      pageSize: 200,
    });

    await expect(loadAllCustomers()).rejects.toBeInstanceOf(IncompleteCustomerListError);
    // Bounded: it gave up rather than hanging.
    expect(vi.mocked(fetchCustomers).mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("stops at the stated total even if a page overlaps", async () => {
    // Page 2 repeats one row from page 1 — a real possibility when the
    // underlying order shifts between requests. The overlap is dropped and
    // the walk still terminates.
    vi.mocked(fetchCustomers).mockImplementation(async (query) => ({
      items: (query?.page ?? 1) === 1 ? customerRange(1, 200) : customerRange(200, 51),
      total: 250,
      page: query?.page ?? 1,
      pageSize: 200,
    }));

    const customers = await loadAllCustomers();
    expect(customers).toHaveLength(250);
    expect(new Set(customers.map((customer) => customer.id)).size).toBe(250);
  });

  it("lets an API failure surface rather than swallowing it", async () => {
    vi.mocked(fetchCustomers).mockRejectedValue(new Error("network down"));
    await expect(loadAllCustomers()).rejects.toThrow("network down");
  });
});
