import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchPublishedAssignmentRepairFindings: vi.fn(),
    buildPublishedAssignmentRepairPlan: vi.fn(),
    applyPublishedAssignmentRepair: vi.fn(),
  };
});

let role: "ADMIN" | "MANAGER" = "ADMIN";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      email: `${role.toLowerCase()}@ultrakil.test`,
      fullName: role === "ADMIN" ? "Admin User" : "Manager User",
      role,
      isActive: true,
    },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

import PublishedAssignmentRepairsPage from "../page";
import {
  ApiError,
  applyPublishedAssignmentRepair,
  buildPublishedAssignmentRepairPlan,
  fetchPublishedAssignmentRepairFindings,
  type PublishedAssignmentRepairFinding,
  type PublishedAssignmentRepairPlan,
} from "@/lib/api-client";

const findings: PublishedAssignmentRepairFinding[] = [
  {
    assignmentId: "assignment-history",
    visitId: "visit-history",
    visitDate: "2026-09-09",
    customerName: "Historic Foods",
    siteName: "Archive store",
    conflicts: [{ code: "MULTIPLE_VEHICLES", message: "Five vehicles were published." }],
    sourceFingerprint: "h".repeat(64),
    timeScope: "HISTORICAL",
    isSelectableForRepair: false,
  },
  {
    assignmentId: "assignment-today",
    visitId: "visit-today",
    visitDate: "2026-09-10",
    customerName: "City Hotel",
    siteName: "Kitchen",
    conflicts: [{ code: "MULTIPLE_VEHICLES", message: "Two vehicles were published." }],
    sourceFingerprint: "t".repeat(64),
    timeScope: "CURRENT_DAY",
    isSelectableForRepair: true,
  },
  {
    assignmentId: "assignment-future",
    visitId: "visit-future",
    visitDate: "2026-09-12",
    customerName: "Harbour Offices",
    siteName: "Tower A",
    conflicts: [{ code: "VEHICLE_REQUIRED", message: "The assigned crew needs transport." }],
    sourceFingerprint: "f".repeat(64),
    timeScope: "FUTURE",
    isSelectableForRepair: true,
  },
];

const replacementOperation = {
  sourceAssignmentId: "assignment-future",
  action: "REPLACED" as const,
  replacement: {
    plannedStartMinute: 540,
    plannedEndMinute: 600,
    crew: [
      { employeeId: "employee-1", fullName: "A Perera", role: "SUPERVISOR" },
      { employeeId: "employee-2", fullName: "B Silva", role: "MEMBER" },
    ],
    vehicles: [
      {
        vehicleId: "vehicle-1",
        label: "Van DAC-2485",
        driverEmployeeId: "employee-1",
        driverName: "A Perera",
      },
    ],
  },
};

const plan: PublishedAssignmentRepairPlan = {
  planHash: "a".repeat(64),
  isValid: true,
  sourceFingerprints: [
    { sourceAssignmentId: "assignment-future", fingerprint: "f".repeat(64) },
  ],
  items: [
    {
      sourceAssignmentId: "assignment-future",
      visitId: "visit-future",
      visitDate: "2026-09-12",
      customerName: "Harbour Offices",
      siteName: "Tower A",
      action: "REPLACED",
      sourceFingerprint: "f".repeat(64),
      isValid: true,
      conflicts: [],
      timeScope: "FUTURE",
    },
    {
      sourceAssignmentId: "assignment-today",
      visitId: "visit-today",
      visitDate: "2026-09-10",
      customerName: "City Hotel",
      siteName: "Kitchen",
      action: "WITHDRAWN",
      sourceFingerprint: "t".repeat(64),
      isValid: true,
      conflicts: [],
      timeScope: "CURRENT_DAY",
    },
  ],
  operations: [
    replacementOperation,
    {
      sourceAssignmentId: "assignment-today",
      action: "WITHDRAWN",
      unassignedReasons: [
        {
          code: "NO_FEASIBLE_VEHICLE",
          message: "No authorised driver and vehicle are available.",
        },
      ],
    },
  ],
};

function mockFindings(items = findings) {
  vi.mocked(fetchPublishedAssignmentRepairFindings).mockResolvedValue({
    items,
    total: items.length,
    page: 1,
    pageSize: 100,
  });
}

async function renderPage() {
  const user = userEvent.setup();
  render(<PublishedAssignmentRepairsPage />);
  await screen.findByRole("heading", { name: "Published Assignment Repair Center" });
  await screen.findByText("Historic Foods");
  return user;
}

beforeEach(() => {
  role = "ADMIN";
  vi.mocked(fetchPublishedAssignmentRepairFindings).mockReset();
  vi.mocked(buildPublishedAssignmentRepairPlan).mockReset();
  vi.mocked(applyPublishedAssignmentRepair).mockReset();
  mockFindings();
});

describe("PublishedAssignmentRepairsPage", () => {
  it("renders and applies an HTTP-shaped current-day plan with its acknowledgement", async () => {
    const httpPlan = {
      planHash: "b".repeat(64),
      isValid: true,
      items: [
        {
          sourceAssignmentId: "assignment-today",
          visitId: "visit-today",
          visitDate: "2026-09-10",
          customerName: "City Hotel",
          siteName: "Kitchen",
          action: "WITHDRAWN" as const,
          sourceFingerprint: "t".repeat(64),
          isValid: true,
          conflicts: [],
          timeScope: "CURRENT_DAY" as const,
        },
      ],
      operations: [
        {
          sourceAssignmentId: "assignment-today",
          action: "WITHDRAWN" as const,
          unassignedReasons: [
            {
              code: "NO_FEASIBLE_VEHICLE",
              message: "No authorised driver and vehicle are available.",
            },
          ],
        },
      ],
      sourceFingerprints: [
        { sourceAssignmentId: "assignment-today", fingerprint: "t".repeat(64) },
      ],
    };
    vi.mocked(buildPublishedAssignmentRepairPlan).mockResolvedValue(httpPlan);
    vi.mocked(applyPublishedAssignmentRepair).mockResolvedValue({
      repairId: "repair-1",
      planHash: httpPlan.planHash,
      idempotencyKey: "browser-key",
      communicationState: "APPLIED_PENDING_COMMUNICATION",
      items: [],
    });
    const user = await renderPage();

    await user.click(screen.getByLabelText(/Select City Hotel/));
    await user.click(
      screen.getByRole("checkbox", { name: /I understand today.s dispatched work/i }),
    );
    await user.click(screen.getByRole("button", { name: "Build repair plan" }));

    const preview = await screen.findByRole("region", { name: "Repair plan preview" });
    expect(within(preview).getByText("Withdraw to Unassigned Visits")).toBeInTheDocument();
    expect(within(preview).getByText("NO_FEASIBLE_VEHICLE")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Repair reason"), {
      target: { value: "Correct invalid vehicle allocations" },
    });
    await user.click(
      screen.getByRole("checkbox", { name: /I confirm this will supersede published assignments/i }),
    );
    await user.click(screen.getByRole("button", { name: "Apply repair" }));

    expect(applyPublishedAssignmentRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        acknowledgeCurrentDay: true,
        operations: httpPlan.operations,
        planHash: httpPlan.planHash,
        sourceFingerprints: httpPlan.sourceFingerprints,
      }),
    );
  });

  it("groups findings into non-selectable history, today, and future work", async () => {
    await renderPage();

    const history = screen.getByRole("region", { name: "History" });
    const today = screen.getByRole("region", { name: "Today" });
    const future = screen.getByRole("region", { name: "Future" });

    expect(within(history).getByText("Historic Foods")).toBeInTheDocument();
    expect(within(history).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(history).getByText(/preserved for audit/i)).toBeInTheDocument();
    expect(within(today).getByLabelText(/Select City Hotel/)).toBeInTheDocument();
    expect(within(future).getByLabelText(/Select Harbour Offices/)).toBeInTheDocument();
  });

  it("builds a zero-write plan only for explicitly selected future findings", async () => {
    vi.mocked(buildPublishedAssignmentRepairPlan).mockResolvedValue({
      ...plan,
      items: [plan.items[0]],
      operations: [plan.operations[0]],
    });
    const user = await renderPage();

    const buildButton = screen.getByRole("button", { name: "Build repair plan" });
    expect(buildButton).toBeDisabled();

    await user.click(screen.getByLabelText(/Select Harbour Offices/));
    await user.click(buildButton);

    expect(buildPublishedAssignmentRepairPlan).toHaveBeenCalledWith({
      sourceAssignmentIds: ["assignment-future"],
    });
    expect(await screen.findByText("Repair plan preview")).toBeInTheDocument();
  });

  it("requires a same-day acknowledgement before planning today's work", async () => {
    vi.mocked(buildPublishedAssignmentRepairPlan).mockResolvedValue(plan);
    const user = await renderPage();

    await user.click(screen.getByLabelText(/Select City Hotel/));
    expect(screen.getByRole("button", { name: "Build repair plan" })).toBeDisabled();

    await user.click(
      screen.getByRole("checkbox", { name: /I understand today.s dispatched work may already be in motion/i }),
    );
    await user.click(screen.getByRole("button", { name: "Build repair plan" }));

    expect(buildPublishedAssignmentRepairPlan).toHaveBeenCalledWith({
      sourceAssignmentIds: ["assignment-today"],
      acknowledgeCurrentDay: true,
    });
  });

  it("shows exact replacement and withdrawal outcomes without pretending a withdrawal was fixed", async () => {
    vi.mocked(buildPublishedAssignmentRepairPlan).mockResolvedValue(plan);
    const user = await renderPage();

    await user.click(screen.getByLabelText(/Select City Hotel/));
    await user.click(screen.getByLabelText(/Select Harbour Offices/));
    await user.click(screen.getByRole("checkbox", { name: /I understand today.s dispatched work/i }));
    await user.click(screen.getByRole("button", { name: "Build repair plan" }));

    const preview = await screen.findByRole("region", { name: "Repair plan preview" });
    expect(within(preview).getByText("employee-1, employee-2")).toBeInTheDocument();
    expect(within(preview).getByText("vehicle-1")).toBeInTheDocument();
    expect(within(preview).getByText("Withdraw to Unassigned Visits")).toBeInTheDocument();
    expect(within(preview).getByText("NO_FEASIBLE_VEHICLE")).toBeInTheDocument();
    expect(within(preview).getByText(/No authorised driver and vehicle/)).toBeInTheDocument();
  });

  it("lets managers inspect and plan but never renders repair mutation controls", async () => {
    role = "MANAGER";
    vi.mocked(buildPublishedAssignmentRepairPlan).mockResolvedValue({
      ...plan,
      items: [plan.items[0]],
      operations: [plan.operations[0]],
    });
    const user = await renderPage();

    await user.click(screen.getByLabelText(/Select Harbour Offices/));
    await user.click(screen.getByRole("button", { name: "Build repair plan" }));

    expect(await screen.findByText(/An administrator must apply this plan/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Repair reason")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply repair" })).not.toBeInTheDocument();
  });

  it("requires an administrator's reason and confirmation, then applies with one browser idempotency key", async () => {
    vi.mocked(buildPublishedAssignmentRepairPlan).mockResolvedValue({
      ...plan,
      items: [plan.items[0]],
      operations: [plan.operations[0]],
    });
    vi.mocked(applyPublishedAssignmentRepair).mockResolvedValue({
      repairId: "repair-1",
      planHash: plan.planHash,
      idempotencyKey: "browser-key",
      communicationState: "APPLIED_PENDING_COMMUNICATION",
      items: [],
    });
    const user = await renderPage();

    await user.click(screen.getByLabelText(/Select Harbour Offices/));
    await user.click(screen.getByRole("button", { name: "Build repair plan" }));

    const applyButton = await screen.findByRole("button", { name: "Apply repair" });
    expect(applyButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Repair reason"), {
      target: { value: "Correct invalid vehicle allocations" },
    });
    await user.click(
      screen.getByRole("checkbox", { name: /I confirm this will supersede published assignments/i }),
    );
    await user.click(applyButton);

    expect(applyPublishedAssignmentRepair).toHaveBeenCalledTimes(1);
    const request = vi.mocked(applyPublishedAssignmentRepair).mock.calls[0][0];
    expect(request).toMatchObject({
      operations: [plan.operations[0]],
      planHash: plan.planHash,
      sourceFingerprints: plan.sourceFingerprints,
      confirmation: true,
      reason: "Correct invalid vehicle allocations",
    });
    expect(request.idempotencyKey).toMatch(/^repair-/);
    expect(await screen.findByText(/applied; crew communication is pending/i)).toBeInTheDocument();
  });

  it("discards a stale plan and reloads findings after RESOURCE_CONFLICT", async () => {
    vi.mocked(buildPublishedAssignmentRepairPlan).mockResolvedValue({
      ...plan,
      items: [plan.items[0]],
      operations: [plan.operations[0]],
    });
    vi.mocked(applyPublishedAssignmentRepair).mockRejectedValue(
      new ApiError({ code: "RESOURCE_CONFLICT", message: "The assignment changed." }),
    );
    const user = await renderPage();

    await user.click(screen.getByLabelText(/Select Harbour Offices/));
    await user.click(screen.getByRole("button", { name: "Build repair plan" }));
    fireEvent.change(screen.getByLabelText("Repair reason"), {
      target: { value: "Correct invalid vehicle allocations" },
    });
    await user.click(
      screen.getByRole("checkbox", { name: /I confirm this will supersede published assignments/i }),
    );
    await user.click(screen.getByRole("button", { name: "Apply repair" }));

    expect(await screen.findByText(/schedule changed, so the stale plan was discarded/i)).toBeInTheDocument();
    expect(screen.queryByText("Repair plan preview")).not.toBeInTheDocument();
    expect(fetchPublishedAssignmentRepairFindings).toHaveBeenCalledTimes(2);
  });

  it("reuses the same browser idempotency key when a non-stale apply is retried", async () => {
    vi.mocked(buildPublishedAssignmentRepairPlan).mockResolvedValue({
      ...plan,
      items: [plan.items[0]],
      operations: [plan.operations[0]],
    });
    vi.mocked(applyPublishedAssignmentRepair)
      .mockRejectedValueOnce(
        new ApiError({ code: "NETWORK_UNAVAILABLE", message: "Connection interrupted." }),
      )
      .mockResolvedValueOnce({
        repairId: "repair-1",
        planHash: plan.planHash,
        idempotencyKey: "browser-key",
        communicationState: "APPLIED_PENDING_COMMUNICATION",
        items: [],
      });
    const user = await renderPage();

    await user.click(screen.getByLabelText(/Select Harbour Offices/));
    await user.click(screen.getByRole("button", { name: "Build repair plan" }));
    fireEvent.change(screen.getByLabelText("Repair reason"), {
      target: { value: "Correct invalid vehicle allocations" },
    });
    await user.click(
      screen.getByRole("checkbox", { name: /I confirm this will supersede published assignments/i }),
    );
    await user.click(screen.getByRole("button", { name: "Apply repair" }));
    await screen.findByText("Connection interrupted.");

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(applyPublishedAssignmentRepair).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(applyPublishedAssignmentRepair).mock.calls.map(([request]) => request);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });
});
