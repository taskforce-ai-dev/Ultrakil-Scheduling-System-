import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  // The Unassigned queue reads ?visit= so a "Why?" link can open on one visit.
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "admin-1",
      email: "admin@ultrakil.test",
      fullName: "Admin User",
      role: "ADMIN",
      isActive: true,
    },
  }),
}));

// Dashboard calls the real API client on mount — stub the requests so this
// smoke test stays fast and deterministic, but keep the real ApiError class
// (Dashboard's catch block does `instanceof ApiError`).
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
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
    fetchVisits: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 500 }),
    fetchCustomers: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 }),
    fetchJobTypes: vi.fn().mockResolvedValue([]),
    fetchCalendar: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    fetchPublishedAssignmentRepairFindings: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      totalCandidates: 0,
      hasNextPage: false,
      page: 1,
      pageSize: 100,
    }),
  };
});

import DashboardPage from "../dashboard/page";
import CalendarPage from "../calendar/page";
import CustomersPage from "../customers/page";
import ServiceAgreementsPage from "../service-agreements/page";
import WorkforcePage from "../workforce/page";
import VehiclesPage from "../vehicles/page";
import DispatchBoardPage from "../dispatch-board/page";
import UnassignedVisitsPage from "../unassigned-visits/page";
import ScheduleHistoryPage from "../schedule-history/page";
import VisitsPage from "../visits/page";
import PublishedAssignmentRepairsPage from "../published-assignment-repairs/page";

describe("route smoke tests", () => {
  it.each([
    ["Dashboard", DashboardPage],
    ["Calendar", CalendarPage],
    ["Customers", CustomersPage],
    ["Service Agreements", ServiceAgreementsPage],
    ["Visit Calendar", VisitsPage],
    ["Workforce", WorkforcePage],
    ["Vehicles", VehiclesPage],
    ["Dispatch Board", DispatchBoardPage],
    ["Unassigned Visits", UnassignedVisitsPage],
    ["Schedule History", ScheduleHistoryPage],
    ["Published Assignment Repair Center", PublishedAssignmentRepairsPage],
  ])("renders the %s page without throwing", async (heading, Page) => {
    render(<Page />);
    expect(await screen.findByRole("heading", { name: heading as string })).toBeInTheDocument();
  });
});
