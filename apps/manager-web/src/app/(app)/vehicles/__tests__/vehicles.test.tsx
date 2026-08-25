import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import VehiclesPage from "../page";

describe("VehiclesPage", () => {
  it("lists all vehicles by default", () => {
    render(<VehiclesPage />);
    expect(screen.getByText("Van — COL-4521")).toBeInTheDocument();
    expect(screen.getByText("Van — KAN-1190")).toBeInTheDocument();
  });

  it("filters vehicles by branch", async () => {
    const user = userEvent.setup();
    render(<VehiclesPage />);

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    expect(screen.getByText("Van — KAN-1190")).toBeInTheDocument();
    expect(screen.getByText("Pickup — KAN-2004")).toBeInTheDocument();
    expect(screen.queryByText("Van — COL-4521")).not.toBeInTheDocument();
  });

  it("shows an empty state when no vehicle matches the search", async () => {
    const user = userEvent.setup();
    render(<VehiclesPage />);

    await user.type(screen.getByLabelText("Search"), "Nonexistent Vehicle");

    expect(await screen.findByText("No vehicles match these filters")).toBeInTheDocument();
  });
});
