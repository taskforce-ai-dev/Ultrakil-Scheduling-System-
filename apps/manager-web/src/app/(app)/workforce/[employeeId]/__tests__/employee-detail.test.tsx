import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/workforce-actions", () => ({
  submitVehicleAuthorizations: vi.fn(),
}));

import { EmployeeDetailView } from "../employee-detail-view";
import { submitVehicleAuthorizations } from "@/lib/workforce-actions";
import { ApiError } from "@/lib/api-client";
import { buildEmployee, buildVehicle } from "@/test/fixtures";

const vehicles = [
  buildVehicle({ id: "vehicle-1", code: "253-4289" }),
  buildVehicle({
    id: "vehicle-2",
    code: "BJG 4419",
    label: "Motor Bike( 01 Person) BJG 4419",
    seatCapacity: 1,
  }),
];

const permanentEmployee = buildEmployee({
  id: "employee-permanent",
  fullName: "D Jayasuriya",
  gradeLabel: "APMS",
  isPmsGrade: true,
  deploymentType: "PERMANENTLY_STATIONED",
  permanentSiteLabel: "Grandview Hotel",
});

const mobileEmployee = buildEmployee({
  id: "employee-mobile",
  fullName: "B Silva",
  gradeLabel: "Junior PMT",
  isPmsGrade: false,
});

describe("EmployeeDetailView", () => {
  afterEach(() => {
    vi.mocked(submitVehicleAuthorizations).mockReset();
  });

  it("renders PMS and permanent-status indicators for a permanently stationed PMS employee", () => {
    render(<EmployeeDetailView employee={permanentEmployee} vehicles={vehicles} />);

    expect(screen.getByText("PMS-grade")).toBeInTheDocument();
    expect(screen.getByText("Permanently stationed")).toBeInTheDocument();
    expect(screen.getByText(/cannot be moved to another site/i)).toBeInTheDocument();
    expect(screen.getByText(/Grandview Hotel/)).toBeInTheDocument();
  });

  it("renders a non-PMS mobile employee without permanent-status messaging", () => {
    render(<EmployeeDetailView employee={mobileEmployee} vehicles={vehicles} />);

    expect(screen.getByText("Not PMS-grade")).toBeInTheDocument();
    expect(screen.queryByText("Permanently stationed")).not.toBeInTheDocument();
  });

  it("shows an actionable backend validation error without changing its meaning", async () => {
    const user = userEvent.setup();
    vi.mocked(submitVehicleAuthorizations).mockRejectedValueOnce(
      new ApiError({
        code: "VEHICLE_DOUBLE_BOOKED",
        message: "This vehicle is already booked for another visit at the same time.",
      })
    );

    render(<EmployeeDetailView employee={mobileEmployee} vehicles={vehicles} />);

    await user.click(screen.getByRole("button", { name: /edit vehicle authorizations/i }));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(
      await screen.findByText("This vehicle is already booked for another visit at the same time.")
    ).toBeInTheDocument();
    expect(screen.getByText("VEHICLE_DOUBLE_BOOKED")).toBeInTheDocument();
  });

  it("confirms the edit before saving — cancelling the dialog does not call the backend", async () => {
    const user = userEvent.setup();
    render(<EmployeeDetailView employee={mobileEmployee} vehicles={vehicles} />);

    await user.click(screen.getByRole("button", { name: /edit vehicle authorizations/i }));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(submitVehicleAuthorizations).not.toHaveBeenCalled();
  });

  it("sends the current and next authorization sets, so the API can work out the difference", async () => {
    const user = userEvent.setup();
    const employee = buildEmployee({
      id: "employee-driver",
      authorizedVehicleIds: ["vehicle-1"],
      authorizedVehicles: [
        { id: "vehicle-1", code: "253-4289", label: "Van( 04 People) 253-4289", seatCapacity: 4 },
      ],
    });
    vi.mocked(submitVehicleAuthorizations).mockResolvedValueOnce(
      buildEmployee({ ...employee, authorizedVehicleIds: ["vehicle-1", "vehicle-2"] })
    );

    render(<EmployeeDetailView employee={employee} vehicles={vehicles} />);

    await user.click(screen.getByRole("button", { name: /edit vehicle authorizations/i }));
    await user.click(screen.getByRole("checkbox", { name: /BJG 4419/i }));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(submitVehicleAuthorizations).toHaveBeenCalledWith(
      "employee-driver",
      ["vehicle-1"],
      ["vehicle-1", "vehicle-2"]
    );
  });
});
