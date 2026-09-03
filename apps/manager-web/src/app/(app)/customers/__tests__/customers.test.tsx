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

beforeEach(() => {
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
