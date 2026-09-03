import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { VehicleDetailView } from "../vehicle-detail-view";
import { buildAuthorizedDrivers, buildVehicle } from "@/test/fixtures";

describe("VehicleDetailView", () => {
  it("lists every authorized driver for the selected vehicle (acceptance scenario)", () => {
    const vehicle = buildVehicle({ id: "veh-1", code: "COL-4521" });
    const { drivers } = buildAuthorizedDrivers({
      drivers: [
        {
          id: "emp-1",
          fullName: "S. Perera",
          gradeLabel: "PMS",
          isPmsGrade: true,
          branchCode: "COLOMBO",
          deploymentType: "MOBILE",
          isActive: true,
        },
        {
          id: "emp-4",
          fullName: "R. Bandara",
          gradeLabel: "Assistant PMS",
          isPmsGrade: true,
          branchCode: "COLOMBO",
          deploymentType: "MOBILE",
          isActive: true,
        },
      ],
    });

    render(<VehicleDetailView vehicle={vehicle} drivers={drivers} />);

    expect(screen.getByText("S. Perera")).toBeInTheDocument();
    expect(screen.getByText("R. Bandara")).toBeInTheDocument();
    expect(screen.getAllByText("Authorized to drive")).toHaveLength(2);
    // The page explicitly disclaims ownership ("not an ownership... assignment") —
    // assert that disclaimer is present, not that the word "owner" never appears.
    expect(screen.getByText(/not an ownership or primary-driver assignment/i)).toBeInTheDocument();
    expect(screen.queryByText(/^owner$/i)).not.toBeInTheDocument();
  });

  it("shows an empty state when a vehicle has no authorized drivers", () => {
    const vehicle = buildVehicle({ id: "veh-4", code: "KAN-2004" });

    render(<VehicleDetailView vehicle={vehicle} drivers={[]} />);

    expect(screen.getByText("No authorized drivers")).toBeInTheDocument();
  });

  it("shows the seat capacity, or says it was not recorded", () => {
    const vehicle = buildVehicle({ seatCapacity: null });

    render(<VehicleDetailView vehicle={vehicle} drivers={[]} />);

    expect(screen.getByText("Not recorded")).toBeInTheDocument();
  });
});
