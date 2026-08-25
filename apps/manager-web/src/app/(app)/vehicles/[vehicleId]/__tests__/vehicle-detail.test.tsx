import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import VehicleDetailPage from "../page";

describe("VehicleDetailPage", () => {
  it("lists every authorized driver for the selected vehicle (acceptance scenario)", async () => {
    // veh-1 (COL-4521) is authorized for emp-1 (S. Perera) and emp-4 (R. Bandara)
    const ui = await VehicleDetailPage({ params: Promise.resolve({ vehicleId: "veh-1" }) });
    render(ui);

    expect(screen.getByText("S. Perera")).toBeInTheDocument();
    expect(screen.getByText("R. Bandara")).toBeInTheDocument();
    expect(screen.getAllByText("Authorized to drive")).toHaveLength(2);
    // The page explicitly disclaims ownership ("not an ownership... assignment") —
    // assert that disclaimer is present, not that the word "owner" never appears.
    expect(screen.getByText(/not an ownership or primary-driver assignment/i)).toBeInTheDocument();
    expect(screen.queryByText(/^owner$/i)).not.toBeInTheDocument();
  });

  it("shows an empty state when a vehicle has no authorized drivers", async () => {
    // veh-4 (KAN-2004) has no employee authorized for it in the fixtures.
    const ui = await VehicleDetailPage({ params: Promise.resolve({ vehicleId: "veh-4" }) });
    render(ui);

    expect(screen.getByText("No authorized drivers")).toBeInTheDocument();
  });

  it("shows a not-found message for an unknown vehicle ID", async () => {
    const ui = await VehicleDetailPage({ params: Promise.resolve({ vehicleId: "does-not-exist" }) });
    render(ui);

    expect(screen.getByText("Vehicle not found")).toBeInTheDocument();
  });
});
