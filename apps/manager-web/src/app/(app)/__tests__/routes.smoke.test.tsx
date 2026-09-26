import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
    fetchOperationsDay: vi.fn().mockResolvedValue({
      date: "2026-09-23",
      summary: { total: 0, ready: 0, proposed: 0, awaitingStaffing: 0, staffingFailed: 0, exceptions: 0, hoursUnconfirmed: 0 },
      items: [],
    }),
    fetchHealth: vi.fn(),
    fetchVisits: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 500 }),
    fetchCustomers: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 }),
    fetchJobTypes: vi.fn().mockResolvedValue([]),
    fetchCalendar: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    fetchCoverage: vi.fn().mockResolvedValue(null),
    fetchPublishedAssignmentRepairFindings: vi.fn().mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 100,
      checkedInPage: 0,
      checkedThrough: 0,
      totalCandidates: 0,
      hasNextPage: false,
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
import { ApiError, fetchOperationsDay } from "@/lib/api-client";

describe("route smoke tests", () => {
  it.each([
    ["Dashboard", DashboardPage],
    ["Calendar", CalendarPage],
    ["Customers", CustomersPage],
    ["Service Agreements", ServiceAgreementsPage],
    ["Generate Schedule", VisitsPage],
    ["Workforce", WorkforcePage],
    ["Vehicles", VehiclesPage],
    ["Dispatch Board", DispatchBoardPage],
    ["Unassigned Visits", UnassignedVisitsPage],
    ["Assign Crew", ScheduleHistoryPage],
    ["Published Assignment Repair Center", PublishedAssignmentRepairsPage],
  ])("renders the %s page without throwing", async (heading, Page) => {
    render(<Page />);
    expect(await screen.findByRole("heading", { name: heading as string })).toBeInTheDocument();
  });

  it("keeps an operations failure announced and understandable while its retry is pending", async () => {
    const firstAttempt = deferred<Awaited<ReturnType<typeof fetchOperationsDay>>>();
    const retryAttempt = deferred<Awaited<ReturnType<typeof fetchOperationsDay>>>();
    vi.mocked(fetchOperationsDay)
      .mockReturnValueOnce(firstAttempt.promise)
      .mockReturnValueOnce(retryAttempt.promise);
    const user = userEvent.setup();

    render(<DashboardPage />);

    await act(async () => {
      firstAttempt.reject(new ApiError({ code: "SERVICE_UNAVAILABLE", message: "offline" }));
    });

    expect(await screen.findByText("Operational status unavailable")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Operational status unavailable");

    await user.click(screen.getByRole("button", { name: /retry operational status/i }));

    expect(screen.getByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByRole("button", { name: /retry operational status/i })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Retrying operational status");

    await act(async () => {
      retryAttempt.resolve({
        date: "2026-09-23",
        branchCode: null,
        summary: { total: 0, ready: 0, proposed: 0, awaitingStaffing: 0, staffingFailed: 0, exceptions: 0, hoursUnconfirmed: 0 },
        items: [],
      });
    });

    expect(screen.queryByText("Retrying operational status")).not.toBeInTheDocument();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
