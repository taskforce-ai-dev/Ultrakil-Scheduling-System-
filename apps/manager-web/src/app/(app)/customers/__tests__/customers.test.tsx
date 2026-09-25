import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, fetchCustomers: vi.fn(), createCustomer: vi.fn(), createServiceSite: vi.fn() };
});

import CustomersPage from "../page";
import { ApiError, createCustomer, createServiceSite, fetchCustomers } from "@/lib/api-client";
import { buildCustomer, buildServiceSite } from "@/test/fixtures";

const existingCustomer = buildCustomer({ id: "customer-1", name: "Cinnamon Grand Colombo" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.mocked(fetchCustomers).mockReset();
  vi.mocked(fetchCustomers).mockResolvedValue({
    items: [existingCustomer],
    total: 1,
    page: 1,
    pageSize: 200,
  });
  vi.mocked(createCustomer).mockReset();
  vi.mocked(createServiceSite).mockReset();
});

async function openForm() {
  const user = userEvent.setup();
  render(<CustomersPage />);
  await screen.findByText("Cinnamon Grand Colombo");
  await user.click(screen.getByRole("button", { name: "Add customer" }));
  return user;
}

describe("CustomersPage", () => {
  it("lists customers from the API", async () => {
    render(<CustomersPage />);
    expect(await screen.findByText("Cinnamon Grand Colombo")).toBeInTheDocument();
  });

  it("shows an actionable error when the list fails to load", async () => {
    vi.mocked(fetchCustomers).mockRejectedValue(
      new ApiError({ code: "UNKNOWN_ERROR", message: "Could not reach the API." })
    );
    render(<CustomersPage />);
    expect(await screen.findByText("Could not reach the API.")).toBeInTheDocument();
  });

  it("is reachable by keyboard and exposes accessible labels", async () => {
    await openForm();

    expect(screen.getByLabelText("Customer name")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Branch")).toHaveLength(1);
    expect(screen.getByLabelText("Site name")).toBeInTheDocument();
    expect(screen.getByLabelText("Customer name")).toHaveFocus();
  });

  it("requires a customer name and at least one site name before saving", async () => {
    const user = await openForm();

    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("Site name is required")).toBeInTheDocument();
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it("adds another site fieldset when 'Add site' is clicked, each independently required", async () => {
    const user = await openForm();

    await user.click(screen.getByRole("button", { name: "Add site" }));

    expect(screen.getAllByLabelText("Site name")).toHaveLength(2);
  });

  it("creates the customer, then each site, and refreshes the list on success", async () => {
    const created = buildCustomer({ id: "customer-2", name: "Test Customer", sites: [] });
    vi.mocked(createCustomer).mockResolvedValue(created);
    vi.mocked(createServiceSite).mockResolvedValue(buildServiceSite({ customerId: "customer-2" }));
    vi.mocked(fetchCustomers).mockResolvedValueOnce({
      items: [existingCustomer],
      total: 1,
      page: 1,
      pageSize: 200,
    }).mockResolvedValueOnce({
      items: [existingCustomer, { ...created, sites: [buildServiceSite({ customerId: "customer-2" })] }],
      total: 2,
      page: 1,
      pageSize: 200,
    });

    const user = await openForm();
    await user.type(screen.getByLabelText("Customer name"), "Test Customer");
    await user.type(screen.getByLabelText("Site name"), "Main Kitchen");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByText("Test Customer")).toBeInTheDocument();
    expect(createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Test Customer", branchCode: "COLOMBO" })
    );
    expect(createServiceSite).toHaveBeenCalledWith(
      "customer-2",
      expect.objectContaining({ name: "Main Kitchen" })
    );
  });

  it("surfaces a backend error (e.g. duplicate customer code) without closing the form", async () => {
    vi.mocked(createCustomer).mockRejectedValue(
      new ApiError({ code: "CUSTOMER_CODE_TAKEN", message: "That customer code is already in use." })
    );

    const user = await openForm();
    await user.type(screen.getByLabelText("Customer name"), "Test Customer");
    await user.type(screen.getByLabelText("Site name"), "Main Kitchen");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByText("That customer code is already in use.")).toBeInTheDocument();
    // The form is still open and usable — the name we typed is still there.
    expect(screen.getByLabelText("Customer name")).toHaveValue("Test Customer");
  });

  it("shows a customer's active vs inactive site counts in text, not colour alone (ULK-O09)", async () => {
    vi.mocked(fetchCustomers).mockResolvedValue({
      items: [
        buildCustomer({
          id: "customer-3",
          name: "Starbucks New Jersey",
          sites: [
            buildServiceSite({ id: "site-active", name: "Main Kitchen", isActive: true }),
            buildServiceSite({ id: "site-inactive", name: "Closed Branch", isActive: false }),
          ],
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 200,
    });

    render(<CustomersPage />);

    expect(await screen.findByText("1 active, 1 inactive")).toBeInTheDocument();
  });

  it("names every site under a customer and labels the inactive one in text, not a count alone (ULK-O08)", async () => {
    vi.mocked(fetchCustomers).mockResolvedValue({
      items: [
        buildCustomer({
          id: "customer-4",
          name: "Harbour Logistics",
          sites: [
            buildServiceSite({ id: "site-open", name: "Warehouse North", isActive: true }),
            buildServiceSite({ id: "site-shut", name: "Warehouse South", isActive: false }),
          ],
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 200,
    });

    render(<CustomersPage />);

    const row = await screen.findByRole("row", { name: /Harbour Logistics/ });
    // Which site is inactive, by name — the count alone never said.
    expect(within(row).getByText("Warehouse North")).toBeInTheDocument();
    expect(within(row).getByText("Warehouse South")).toBeInTheDocument();

    // The label is text, so it survives greyscale and a colour-blind reader,
    // and it sits on the inactive site rather than the active one. The
    // customer itself is active, so the only other "Inactive" candidate in
    // this row would be its status badge — which reads "Active".
    const inactiveLabels = within(row).getAllByText("Inactive");
    expect(inactiveLabels).toHaveLength(1);
    expect(within(row).getByText("Active")).toBeInTheDocument();

    const inactiveSiteItem = within(row).getByText("Warehouse South").closest("li");
    expect(inactiveSiteItem).not.toBeNull();
    expect(within(inactiveSiteItem as HTMLElement).getByText("Inactive")).toBeInTheDocument();
    const activeSiteItem = within(row).getByText("Warehouse North").closest("li");
    expect(within(activeSiteItem as HTMLElement).queryByText("Inactive")).toBeNull();
  });

  it("defaults to active customers only, and switching to Inactive re-fetches and labels them in text (ULK-O09)", async () => {
    const inactiveCustomer = buildCustomer({
      id: "customer-inactive",
      name: "Closed Client Ltd",
      isActive: false,
      sites: [],
    });
    vi.mocked(fetchCustomers).mockImplementation((query) =>
      Promise.resolve(
        query?.active === false
          ? { items: [inactiveCustomer], total: 1, page: 1, pageSize: 200 }
          : { items: [existingCustomer], total: 1, page: 1, pageSize: 200 }
      )
    );

    const user = userEvent.setup();
    render(<CustomersPage />);
    await screen.findByText("Cinnamon Grand Colombo");
    // The default view never fetched inactive customers at all.
    expect(fetchCustomers).toHaveBeenCalledWith(expect.objectContaining({ active: true }));

    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: "Inactive" }));

    expect(await screen.findByText("Closed Client Ltd")).toBeInTheDocument();
    expect(screen.queryByText("Cinnamon Grand Colombo")).not.toBeInTheDocument();
    expect(fetchCustomers).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    // Text label, not colour alone — scoped to the table, since the Status
    // filter's own (still-mounted) option list can also contain the word.
    expect(within(screen.getByRole("table")).getByText("Inactive")).toBeInTheDocument();
  });

  it.each(["success", "failure"])("ignores an older active-list %s after the inactive list loads", async (outcome) => {
    const inactiveCustomer = buildCustomer({
      id: "customer-inactive",
      name: "Closed Client Ltd",
      isActive: false,
      sites: [],
    });
    const older = deferred<Awaited<ReturnType<typeof fetchCustomers>>>();
    const newer = deferred<Awaited<ReturnType<typeof fetchCustomers>>>();
    vi.mocked(fetchCustomers).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const user = userEvent.setup();
    render(<CustomersPage />);
    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: "Inactive" }));
    expect(fetchCustomers).toHaveBeenCalledTimes(2);

    await act(async () => newer.resolve({ items: [inactiveCustomer], total: 1, page: 1, pageSize: 200 }));
    expect(screen.getByText("Closed Client Ltd")).toBeInTheDocument();
    await act(async () => {
      if (outcome === "success") {
        older.resolve({ items: [existingCustomer], total: 1, page: 1, pageSize: 200 });
      } else {
        older.reject(new Error("Old request failed"));
      }
    });
    expect(screen.getByText("Closed Client Ltd")).toBeInTheDocument();
    expect(screen.queryByText("Cinnamon Grand Colombo")).not.toBeInTheDocument();
    expect(screen.queryByText("Old request failed")).not.toBeInTheDocument();
  });

  it("collapses a rapid double-click on Save into a single request", async () => {
    let resolveCreate: (() => void) | undefined;
    vi.mocked(createCustomer).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = () => resolve(buildCustomer({ id: "customer-2", name: "Test Customer", sites: [] }));
        })
    );

    const user = await openForm();
    await user.type(screen.getByLabelText("Customer name"), "Test Customer");
    await user.type(screen.getByLabelText("Site name"), "Main Kitchen");

    const button = screen.getByRole("button", { name: "Save customer" });
    // Two clicks fired without awaiting between them — a genuine double-click,
    // not two sequential, fully-settled ones.
    await userEvent.click(button, { skipHover: true });
    await userEvent.click(button, { skipHover: true });

    expect(createCustomer).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCreate?.();
    });
  });
});

/**
 * ULK-O12. This table used to ask for `pageSize: 200` and render whatever came
 * back with nothing on screen to say more existed. A customer at position 201
 * was not filtered out and not on a later page — the portal simply had no way
 * to reach them, and no way to tell you so.
 */
describe("CustomersPage pagination", () => {
  /** Customers named so the nth is identifiable by name alone. */
  function customerRange(from: number, count: number) {
    return Array.from({ length: count }, (_, index) =>
      buildCustomer({ id: `customer-${from + index}`, name: `Customer ${from + index}`, sites: [] })
    );
  }

  /** Serves `total` customers in pages of 50, the way the API does. */
  function servePages(total: number) {
    vi.mocked(fetchCustomers).mockImplementation(async (query) => {
      const page = query?.page ?? 1;
      const pageSize = query?.pageSize ?? 50;
      const start = (page - 1) * pageSize;
      return {
        items: customerRange(start + 1, Math.max(0, Math.min(pageSize, total - start))),
        total,
        page,
        pageSize,
      };
    });
  }

  it("states the API's total and the range on screen", async () => {
    servePages(250);
    render(<CustomersPage />);

    expect(await screen.findByTestId("pagination-range")).toHaveTextContent(
      "Showing 1–50 of 250 customers"
    );
    expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();
  });

  it("asks the API for one page, not two hundred rows", async () => {
    servePages(250);
    render(<CustomersPage />);
    await screen.findByText("Customer 1");

    expect(fetchCustomers).toHaveBeenCalledWith({ page: 1, pageSize: 50, active: true });
  });

  it("reaches customer 201 through the pager", async () => {
    servePages(250);
    const user = userEvent.setup();
    render(<CustomersPage />);
    await screen.findByText("Customer 1");

    // Page 5 holds rows 201–250.
    for (let click = 0; click < 4; click += 1) {
      await user.click(screen.getByRole("button", { name: /Next/ }));
      await screen.findByText(`Customer ${1 + (click + 1) * 50}`);
    }

    expect(screen.getByText("Customer 201")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-range")).toHaveTextContent(
      "Showing 201–250 of 250 customers"
    );
    expect(fetchCustomers).toHaveBeenCalledWith({ page: 5, pageSize: 50, active: true });
  });

  it("disables Previous on the first page and Next on the last", async () => {
    servePages(60);
    const user = userEvent.setup();
    render(<CustomersPage />);
    await screen.findByText("Customer 1");

    expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Customer 51");

    expect(screen.getByRole("button", { name: /Previous/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
  });

  it("returns to page 1 when the status filter changes", async () => {
    servePages(250);
    const user = userEvent.setup();
    render(<CustomersPage />);
    await screen.findByText("Customer 1");

    await user.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Customer 51");
    expect(fetchCustomers).toHaveBeenCalledWith({ page: 2, pageSize: 50, active: true });

    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: "Inactive" }));
    await screen.findByText("Customer 1");

    // Page 2 of Inactive is a different population and very likely empty —
    // which would read as "there are no inactive customers".
    expect(fetchCustomers).toHaveBeenLastCalledWith({ page: 1, pageSize: 50, active: false });
  });

  it("falls back to page 1 when the list shrank under an open page", async () => {
    servePages(250);
    const user = userEvent.setup();
    render(<CustomersPage />);
    await screen.findByText("Customer 1");

    await user.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Customer 51");

    // Customers were deactivated while page 2 was open: page 2 no longer exists.
    servePages(10);
    await user.click(screen.getByRole("button", { name: /Previous/ }));
    await user.click(screen.getByRole("button", { name: /Next/ }));

    expect(await screen.findByText("Customer 1")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-range")).toHaveTextContent(
      "Showing 1–10 of 10 customers"
    );
  });

  it("ignores a page whose request was overtaken by a filter change", async () => {
    const slowSecondPage = deferred<Awaited<ReturnType<typeof fetchCustomers>>>();
    vi.mocked(fetchCustomers).mockImplementation(async (query) => {
      // Page 2 of the active list never answers until the test says so.
      if (query?.page === 2 && query?.active === true) return slowSecondPage.promise;
      if (query?.active === false) {
        return {
          items: [buildCustomer({ id: "inactive-1", name: "Closed Client Ltd", sites: [] })],
          total: 1,
          page: 1,
          pageSize: 50,
        };
      }
      return { items: customerRange(1, 50), total: 250, page: 1, pageSize: 50 };
    });

    const user = userEvent.setup();
    render(<CustomersPage />);
    await screen.findByText("Customer 1");

    await user.click(screen.getByRole("button", { name: /Next/ }));

    // The filter changes while page 2 is still in flight.
    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: "Inactive" }));
    await screen.findByText("Closed Client Ltd");

    // The overtaken page 2 lands last. Without a fence it would repaint the
    // table with active customers under a control that reads Inactive.
    await act(async () => {
      slowSecondPage.resolve({
        items: customerRange(51, 50),
        total: 250,
        page: 2,
        pageSize: 50,
      });
    });

    expect(screen.getByText("Closed Client Ltd")).toBeInTheDocument();
    expect(screen.queryByText("Customer 51")).not.toBeInTheDocument();
  });
});
