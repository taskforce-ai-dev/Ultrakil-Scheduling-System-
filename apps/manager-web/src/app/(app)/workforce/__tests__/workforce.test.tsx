import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import WorkforcePage from "../page";

describe("WorkforcePage", () => {
  it("lists all employees by default", () => {
    render(<WorkforcePage />);
    expect(screen.getByText("S. Perera")).toBeInTheDocument();
    expect(screen.getByText("N. Fernando")).toBeInTheDocument();
    expect(screen.getByText("T. Wickrama")).toBeInTheDocument();
  });

  it("filters to PMS-grade Colombo employees (acceptance scenario)", async () => {
    const user = userEvent.setup();
    render(<WorkforcePage />);

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Colombo" }));

    await user.click(screen.getByLabelText("PMS grade"));
    await user.click(await screen.findByRole("option", { name: "PMS-grade only" }));

    // Colombo + PMS-grade: S. Perera, A. Silva, R. Bandara
    expect(screen.getByText("S. Perera")).toBeInTheDocument();
    expect(screen.getByText("A. Silva")).toBeInTheDocument();
    expect(screen.getByText("R. Bandara")).toBeInTheDocument();

    // Excluded: Colombo but not PMS-grade, and any Kandy employee
    expect(screen.queryByText("T. Wickrama")).not.toBeInTheDocument();
    expect(screen.queryByText("N. Fernando")).not.toBeInTheDocument();
    expect(screen.queryByText("K. Jayasuriya")).not.toBeInTheDocument();
  });

  it("filters to permanently stationed employees and shows their sites (acceptance scenario)", async () => {
    const user = userEvent.setup();
    render(<WorkforcePage />);

    await user.click(screen.getByLabelText("Permanent status"));
    await user.click(await screen.findByRole("option", { name: "Permanently stationed only" }));

    expect(screen.getByText("A. Silva")).toBeInTheDocument();
    expect(screen.getByText("T. Wickrama")).toBeInTheDocument();
    expect(screen.queryByText("S. Perera")).not.toBeInTheDocument();
  });

  it("shows an empty state when no employee matches the search", async () => {
    const user = userEvent.setup();
    render(<WorkforcePage />);

    await user.type(screen.getByLabelText("Search"), "Nonexistent Person");

    expect(await screen.findByText("No employees match these filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it("is reachable by keyboard: Tab reaches the search input first", async () => {
    const user = userEvent.setup();
    render(<WorkforcePage />);

    await user.tab();
    expect(screen.getByLabelText("Search")).toHaveFocus();
  });
});
