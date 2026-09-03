import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { VehicleDetailView } from "../vehicle-detail-view";
import type { AuthorizedDrivers } from "@/lib/api-client";
import { buildAuthorizedDrivers, buildVehicle } from "@/test/fixtures";

const driverS: AuthorizedDrivers["drivers"][number] = {
  id: "emp-1",
  fullName: "S. Perera",
  gradeLabel: "PMS",
  isPmsGrade: true,
  branchCode: "COLOMBO",
  deploymentType: "MOBILE",
  isActive: true,
};
const driverR: AuthorizedDrivers["drivers"][number] = {
  id: "emp-4",
  fullName: "R. Bandara",
  gradeLabel: "Junior PMT",
  isPmsGrade: false,
  branchCode: "COLOMBO",
  deploymentType: "MOBILE",
  isActive: true,
};

describe("VehicleDetailView", () => {
  it("lists every authorized driver for the selected vehicle (acceptance scenario)", () => {
    render(
      <VehicleDetailView
        vehicle={buildVehicle({ id: "veh-1", code: "COL-4521" })}
        authorized={buildAuthorizedDrivers({ drivers: [driverS, driverR], total: 2 })}
      />
    );

    expect(screen.getByText("S. Perera")).toBeInTheDocument();
    expect(screen.getByText("R. Bandara")).toBeInTheDocument();
    expect(screen.getAllByText("Authorized to drive")).toHaveLength(2);
    // The page explicitly disclaims ownership ("not an ownership... assignment") —
    // assert that disclaimer is present, not that the word "owner" never appears.
    expect(screen.getByText(/not an ownership or primary-driver assignment/i)).toBeInTheDocument();
    expect(screen.queryByText(/^owner$/i)).not.toBeInTheDocument();
  });

  it("shows DAC-2485's three drivers equally, in a stable order that can't read as a priority (ULK-O09 acceptance scenario)", () => {
    // Real names from the ticket's required test scenarios, in scrambled
    // API-return order — the point is that the page doesn't just echo
    // whatever order the backend happened to return, which someone could
    // otherwise misread as "first = primary driver".
    const supun: AuthorizedDrivers["drivers"][number] = {
      id: "emp-supun",
      fullName: "T M Supun Tharaka Wijeweera",
      gradeLabel: "PMS",
      isPmsGrade: true,
      branchCode: "COLOMBO",
      deploymentType: "MOBILE",
      isActive: true,
    };
    const tharilingam: AuthorizedDrivers["drivers"][number] = {
      id: "emp-tharilingam",
      fullName: "S Tharilingam",
      gradeLabel: "Technician",
      isPmsGrade: false,
      branchCode: "COLOMBO",
      deploymentType: "MOBILE",
      isActive: true,
    };
    const selvaraj: AuthorizedDrivers["drivers"][number] = {
      id: "emp-selvaraj",
      fullName: "P Selvaraj",
      gradeLabel: "Technician",
      isPmsGrade: false,
      branchCode: "COLOMBO",
      deploymentType: "MOBILE",
      isActive: true,
    };

    render(
      <VehicleDetailView
        vehicle={buildVehicle({ code: "DAC-2485", label: "Bolero DAC-2485" })}
        authorized={buildAuthorizedDrivers({
          drivers: [supun, tharilingam, selvaraj],
          total: 3,
        })}
      />
    );

    const names = ["T M Supun Tharaka Wijeweera", "S Tharilingam", "P Selvaraj"];
    for (const name of names) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // Every driver row carries the same "Authorized to drive" caption — none
    // singled out as owner, primary, or backup. (The page's own disclaimer
    // legitimately says "not... primary-driver" once, elsewhere — this
    // checks no *driver row* is labelled that way.)
    const driverRows = screen.getAllByText("Authorized to drive");
    expect(driverRows).toHaveLength(3);
    for (const row of driverRows) {
      expect(row.closest("li")).not.toHaveTextContent(/primary driver|backup driver|\bowner\b/i);
    }

    // Alphabetical, regardless of the scrambled input order above.
    const rows = screen.getAllByRole("link", { name: new RegExp(names.join("|")) });
    expect(rows.map((row) => row.textContent)).toEqual([
      "P Selvaraj",
      "S Tharilingam",
      "T M Supun Tharaka Wijeweera",
    ]);
  });

  it("shows an empty state when a vehicle has no authorized drivers", () => {
    render(
      <VehicleDetailView
        vehicle={buildVehicle({ id: "veh-4", code: "KAN-2004" })}
        authorized={buildAuthorizedDrivers({ drivers: [], total: 0 })}
      />
    );

    expect(screen.getByText("No authorized drivers")).toBeInTheDocument();
  });

  it("shows the vehicle's seat capacity and branch", () => {
    render(
      <VehicleDetailView
        vehicle={buildVehicle({ label: "Van( 04 People) 253-4289", seatCapacity: 4, branchCode: "KANDY" })}
        authorized={buildAuthorizedDrivers()}
      />
    );

    expect(screen.getByText("Van( 04 People) 253-4289")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Kandy")).toBeInTheDocument();
  });
});
