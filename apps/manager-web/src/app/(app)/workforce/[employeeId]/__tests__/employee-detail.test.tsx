import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/mock-data/actions", () => ({
  submitVehicleAuthorizations: vi.fn().mockResolvedValue(undefined),
}));

import { EmployeeDetailView } from "../employee-detail-view";
import { mockEmployees } from "@/lib/mock-data";
import { submitVehicleAuthorizations } from "@/lib/mock-data/actions";
import { ApiError } from "@/lib/api-client";

const permanentEmployee = mockEmployees.find((employee) => employee.id === "emp-3")!;
const mobileEmployee = mockEmployees.find((employee) => employee.id === "emp-2")!;

describe("EmployeeDetailView", () => {
  afterEach(() => {
    vi.mocked(submitVehicleAuthorizations).mockReset().mockResolvedValue(undefined);
  });

  it("renders PMS and permanent-status indicators for a permanently stationed PMS employee", () => {
    render(<EmployeeDetailView employee={permanentEmployee} />);

    expect(screen.getByText("PMS-grade")).toBeInTheDocument();
    expect(screen.getByText("Permanently stationed")).toBeInTheDocument();
    expect(screen.getByText(/cannot be moved to another site/i)).toBeInTheDocument();
    expect(screen.getByText(/Grandview Hotel/)).toBeInTheDocument();
  });

  it("renders a non-PMS mobile employee without permanent-status messaging", () => {
    render(<EmployeeDetailView employee={mobileEmployee} />);

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

    render(<EmployeeDetailView employee={mobileEmployee} />);

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
    render(<EmployeeDetailView employee={mobileEmployee} />);

    await user.click(screen.getByRole("button", { name: /edit vehicle authorizations/i }));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(submitVehicleAuthorizations).not.toHaveBeenCalled();
  });
});
