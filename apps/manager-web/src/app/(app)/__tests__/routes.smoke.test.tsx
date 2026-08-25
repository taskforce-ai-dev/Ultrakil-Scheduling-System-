import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Dashboard calls the real API client on mount — stub it so this smoke test
// stays fast and deterministic instead of making a real network request.
vi.mock("@/lib/api-client", () => ({
  fetchMeta: vi.fn().mockResolvedValue({
    apiVersion: "0.1.0",
    timezone: "Asia/Colombo",
    branchCodes: ["COLOMBO", "KANDY"],
    weekdays: [],
    pmsGradeLabels: [],
    frequencyUnits: {},
    errorCodes: [],
  }),
  fetchHealth: vi.fn(),
}));

import DashboardPage from "../dashboard/page";
import CustomersPage from "../customers/page";
import ServiceAgreementsPage from "../service-agreements/page";
import WorkforcePage from "../workforce/page";
import VehiclesPage from "../vehicles/page";
import DispatchBoardPage from "../dispatch-board/page";
import UnassignedVisitsPage from "../unassigned-visits/page";
import ScheduleHistoryPage from "../schedule-history/page";

describe("route smoke tests", () => {
  it.each([
    ["Dashboard", DashboardPage],
    ["Customers", CustomersPage],
    ["Service Agreements", ServiceAgreementsPage],
    ["Workforce", WorkforcePage],
    ["Vehicles", VehiclesPage],
    ["Dispatch Board", DispatchBoardPage],
    ["Unassigned Visits", UnassignedVisitsPage],
    ["Schedule History", ScheduleHistoryPage],
  ])("renders the %s page without throwing", async (heading, Page) => {
    render(<Page />);
    expect(await screen.findByRole("heading", { name: heading as string })).toBeInTheDocument();
  });
});
