import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import CustomersPage from "../page";

async function openForm() {
  const user = userEvent.setup();
  render(<CustomersPage />);
  await user.click(screen.getByRole("button", { name: "Add customer" }));
  return user;
}

describe("CustomersPage", () => {
  it("is reachable by keyboard and exposes accessible labels", async () => {
    await openForm();

    expect(screen.getByLabelText("Customer name")).toBeInTheDocument();
    // "Branch" labels both the customer-level and the per-site select.
    expect(screen.getAllByLabelText("Branch")).toHaveLength(2);
    expect(screen.getByLabelText("Site name")).toBeInTheDocument();
    // The drawer traps focus and lands on the first field automatically.
    expect(screen.getByLabelText("Customer name")).toHaveFocus();
  });

  it("requires a customer name and at least one site name before saving", async () => {
    const user = await openForm();

    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("Site name is required")).toBeInTheDocument();
  });

  it("adds another site fieldset when 'Add site' is clicked, each independently required", async () => {
    const user = await openForm();

    await user.click(screen.getByRole("button", { name: "Add site" }));

    const siteNameInputs = screen.getAllByLabelText("Site name");
    expect(siteNameInputs).toHaveLength(2);

    await user.type(siteNameInputs[0], "Main Kitchen");
    await user.click(screen.getByLabelText("Customer name"));
    await user.type(screen.getByLabelText("Customer name"), "Test Customer");
    await user.click(screen.getByRole("button", { name: "Save customer" }));

    // The second site is still blank, so its own validation still fires.
    expect(await screen.findByText("Site name is required")).toBeInTheDocument();
  });

  it("saves a customer with multiple sites and lists it in the table", async () => {
    const user = await openForm();

    await user.type(screen.getByLabelText("Customer name"), "Test Customer");
    await user.type(screen.getByLabelText("Site name"), "Main Kitchen");
    await user.click(screen.getByRole("button", { name: "Add site" }));
    const siteNameInputs = screen.getAllByLabelText("Site name");
    await user.type(siteNameInputs[1], "Banquet Hall");

    await user.click(screen.getByRole("button", { name: "Save customer" }));

    expect(await screen.findByText("Test Customer")).toBeInTheDocument();
    // Site count column for the new row.
    const row = screen.getByText("Test Customer").closest("tr");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("2");
  });
});
