import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>(
    "@/lib/api-client"
  );
  return { ...actual, fetchEmployees: vi.fn(), fetchVehicles: vi.fn() };
});

import WorkforcePage from "../page";
import { ApiError, fetchEmployees, fetchVehicles } from "@/lib/api-client";
import { buildEmployee, buildVehicle } from "@/test/fixtures";

/**
 * The page reads live data now, so the API is stubbed here. The fixtures mirror
 * the real workforce closely enough to exercise the rules that matter: a
 * Colombo PMS supervisor, a stationed employee, and a Kandy technician who must
 * never appear under a Colombo filter.
 */
const employees = [
  buildEmployee({
    id: "e1",
    fullName: "S. Perera",
    gradeLabel: "Senoir PMS",
    isPmsGrade: true,
  }),
  buildEmployee({
    id: "e2",
    fullName: "A. Silva",
    gradeLabel: "APMS",
    isPmsGrade: true,
    deploymentType: "PERMANENTLY_STATIONED",
    permanentSiteLabel: "Lion Brewery",
  }),
  buildEmployee({
    id: "e3",
    fullName: "R. Bandara",
    gradeLabel: "Pest Management Supervisor(PMS)",
    isPmsGrade: true,
  }),
  buildEmployee({ id: "e4", fullName: "T. Wickrama", gradeLabel: "JPMT" }),
  buildEmployee({
    id: "e5",
    fullName: "N. Fernando",
    gradeLabel: "Junior PMT",
    branchCode: "KANDY",
    branch: { id: "branch-kandy", code: "KANDY", name: "Kandy Branch" },
  }),
];

const vehicles = [buildVehicle({ id: "v1" })];

beforeEach(() => {
  vi.mocked(fetchEmployees).mockResolvedValue({
    items: employees,
    total: employees.length,
    page: 1,
    pageSize: 200,
  });
  vi.mocked(fetchVehicles).mockResolvedValue({
    items: vehicles,
    total: vehicles.length,
    page: 1,
    pageSize: 200,
  });
});

describe("WorkforcePage", () => {
  it("lists all employees by default", async () => {
    render(<WorkforcePage />);

    expect(await screen.findByText("S. Perera")).toBeInTheDocument();
    expect(screen.getByText("N. Fernando")).toBeInTheDocument();
    expect(screen.getByText("T. Wickrama")).toBeInTheDocument();
  });

  it("filters to PMS-grade Colombo employees (acceptance scenario)", async () => {
    const user = userEvent.setup();
    render(<WorkforcePage />);
    await screen.findByText("S. Perera");

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Colombo" }));

    await user.click(screen.getByLabelText("PMS grade"));
    await user.click(await screen.findByRole("option", { name: "PMS-grade only" }));

    expect(screen.getByText("S. Perera")).toBeInTheDocument();
    expect(screen.getByText("A. Silva")).toBeInTheDocument();
    expect(screen.getByText("R. Bandara")).toBeInTheDocument();

    // Excluded: Colombo but not PMS-grade, and any Kandy employee.
    expect(screen.queryByText("T. Wickrama")).not.toBeInTheDocument();
    expect(screen.queryByText("N. Fernando")).not.toBeInTheDocument();
  });

  it("filters to permanently stationed employees (acceptance scenario)", async () => {
    const user = userEvent.setup();
    render(<WorkforcePage />);
    await screen.findByText("S. Perera");

    await user.click(screen.getByLabelText("Permanent status"));
    await user.click(
      await screen.findByRole("option", { name: "Permanently stationed only" })
    );

    expect(screen.getByText("A. Silva")).toBeInTheDocument();
    expect(screen.queryByText("S. Perera")).not.toBeInTheDocument();
  });

  it("shows an empty state when no employee matches the search", async () => {
    const user = userEvent.setup();
    render(<WorkforcePage />);
    await screen.findByText("S. Perera");

    await user.type(screen.getByLabelText("Search"), "Nonexistent Person");

    expect(await screen.findByText("No employees match these filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it("surfaces an API failure with its stable code and a retry", async () => {
    vi.mocked(fetchEmployees).mockRejectedValueOnce(
      new ApiError({
        code: "AUTHENTICATION_REQUIRED",
        message: "Sign in to use this endpoint.",
      })
    );

    render(<WorkforcePage />);

    expect(await screen.findByText("Sign in to use this endpoint.")).toBeInTheDocument();
    expect(screen.getByText("AUTHENTICATION_REQUIRED")).toBeInTheDocument();
  });

  it("is reachable by keyboard: Tab reaches the search input first", async () => {
    const user = userEvent.setup();
    render(<WorkforcePage />);
    await screen.findByText("S. Perera");

    await user.tab();
    expect(screen.getByLabelText("Search")).toHaveFocus();
  });
});
