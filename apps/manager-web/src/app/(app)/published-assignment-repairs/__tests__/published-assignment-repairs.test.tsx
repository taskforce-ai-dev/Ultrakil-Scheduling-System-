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

import { buildConflict } from "@/test/fixtures";

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
    conflicts: [buildConflict({ code: "TOO_MANY_VEHICLES", message: "Five vehicles were published." })],
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
    conflicts: [buildConflict({ code: "TOO_MANY_VEHICLES", message: "Two vehicles were published." })],
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
    conflicts: [buildConflict({ code: "CREW_CANNOT_TRAVEL", message: "The assigned crew needs transport." })],
    sourceFingerprint: "f".repeat(64),
    timeScope: "FUTURE",
    isSelectableForRepair: true,
  },
];

/**
 * Everything below is the exact JSON the API returns, taken from the generated
 * contract. A fixture that invents a planner field is a test that passes while
 * the real screen crashes, which is precisely what this page got wrong before.
 */
const replacementOperation: PublishedAssignmentRepairPlan["operations"][number] = {
  sourceAssignmentId: "assignment-future",
  action: "REPLACED",
  replacement: {
    plannedStartMinute: 540,
    plannedEndMinute: 600,
    crew: [
      { employeeId: "employee-1", role: "SUPERVISOR" },
      { employeeId: "employee-2", role: "TECHNICIAN" },
    ],
    vehicles: [{ vehicleId: "vehicle-1", driverEmployeeId: "employee-1" }],
  },
};

const withdrawalOperation: PublishedAssignmentRepairPlan["operations"][number] = {
  sourceAssignmentId: "assignment-today",
  action: "WITHDRAWN",
  unassignedReasons: [
    {
      code: "NO_AUTHORIZED_DRIVER",
      message: "No authorised driver and vehicle are available.",
    },
  ],
};

const plan: PublishedAssignmentRepairPlan = {
  planHash: "a".repeat(64),
  isValid: true,
  sourceFingerprints: [
    { sourceAssignmentId: "assignment-future", fingerprint: "f".repeat(64) },
    { sourceAssignmentId: "assignment-today", fingerprint: "t".repeat(64) },
  ],
  resourceLabels: {
    employees: [
      { employeeId: "employee-1", fullName: "A Perera" },
      { employeeId: "employee-2", fullName: "B Silva" },
    ],
    vehicles: [{ vehicleId: "vehicle-1", label: "Van DAC-2485" }],
  },
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
  operations: [replacementOperation, withdrawalOperation],
};

function findingsPage(
  items: PublishedAssignmentRepairFinding[],
  coverage: {
    page?: number;
    checkedInPage?: number;
    checkedThrough?: number;
    totalCandidates?: number;
    hasNextPage?: boolean;
  } = {},
) {
  const checkedInPage = coverage.checkedInPage ?? items.length;
  return {
    items,
    page: coverage.page ?? 1,
    pageSize: 100,
    checkedInPage,
    checkedThrough: coverage.checkedThrough ?? checkedInPage,
    totalCandidates: coverage.totalCandidates ?? checkedInPage,
    hasNextPage: coverage.hasNextPage ?? false,
  };
}

function mockFindings(items = findings) {
  vi.mocked(fetchPublishedAssignmentRepairFindings).mockResolvedValue(findingsPage(items));
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
  it("checks one bounded page on mount and asks for nothing more on its own", async () => {
    vi.mocked(fetchPublishedAssignmentRepairFindings).mockResolvedValue(
      findingsPage(findings, {
        page: 1,
        checkedInPage: 100,
        checkedThrough: 100,
        totalCandidates: 260,
        hasNextPage: true,
      }),
    );

    await renderPage();

    // The old screen looped until it had every page, re-scanning all published
    // history on every render. One mount must cost exactly one request.
    expect(fetchPublishedAssignmentRepairFindings).toHaveBeenCalledTimes(1);
    expect(fetchPublishedAssignmentRepairFindings).toHaveBeenCalledWith({
      page: 1,
      pageSize: 100,
    });
    expect(
      await screen.findByText(/Checked 100 of 260 published assignments/),
    ).toBeInTheDocument();
    expect(screen.getByText(/have not been validated yet/)).toBeInTheDocument();
  });

  it("checks the next candidate page only when the manager asks, merging without duplicates", async () => {
    const laterFinding: PublishedAssignmentRepairFinding = {
      ...findings[2],
      assignmentId: "assignment-future-2",
      visitId: "visit-future-2",
      customerName: "Lakeside Depot",
      siteName: "Bay 3",
    };
    vi.mocked(fetchPublishedAssignmentRepairFindings)
      .mockResolvedValueOnce(
        findingsPage(findings, {
          page: 1,
          checkedInPage: 100,
          checkedThrough: 100,
          totalCandidates: 160,
          hasNextPage: true,
        }),
      )
      .mockResolvedValueOnce(
        findingsPage([findings[2], laterFinding], {
          page: 2,
          checkedInPage: 60,
          checkedThrough: 160,
          totalCandidates: 160,
          hasNextPage: false,
        }),
      );

    const user = await renderPage();
    expect(fetchPublishedAssignmentRepairFindings).toHaveBeenCalledTimes(1);

    await user.click(screen.getByLabelText(/Select City Hotel/));
    await user.click(screen.getByRole("button", { name: "Load more findings" }));

    expect(fetchPublishedAssignmentRepairFindings).toHaveBeenCalledTimes(2);
    expect(fetchPublishedAssignmentRepairFindings).toHaveBeenLastCalledWith({
      page: 2,
      pageSize: 100,
    });
    expect(await screen.findByText("Lakeside Depot")).toBeInTheDocument();
    // The repeated finding is merged by assignmentId, never listed twice.
    expect(screen.getAllByText("Harbour Offices")).toHaveLength(1);
    expect(screen.getByLabelText(/Select City Hotel/)).toBeChecked();
    expect(
      await screen.findByText(/Checked 160 of 160 published assignments/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more findings" })).not.toBeInTheDocument();
  });

  it("reports a failed load-more without discarding the findings already checked", async () => {
    vi.mocked(fetchPublishedAssignmentRepairFindings)
      .mockResolvedValueOnce(
        findingsPage(findings, {
          page: 1,
          checkedInPage: 100,
          checkedThrough: 100,
          totalCandidates: 260,
          hasNextPage: true,
        }),
      )
      .mockRejectedValueOnce(
        new ApiError({ code: "NETWORK_UNAVAILABLE", message: "Connection interrupted." }),
      );

    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: "Load more findings" }));

    expect(
      await screen.findByText("Couldn't check more published assignments"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load repair findings")).not.toBeInTheDocument();
    expect(screen.getByText("Historic Foods")).toBeInTheDocument();
    expect(screen.getByLabelText(/Select Harbour Offices/)).toBeInTheDocument();
  });

  it("says an unchecked remainder is unchecked instead of claiming nothing is wrong", async () => {
    vi.mocked(fetchPublishedAssignmentRepairFindings).mockResolvedValue(
      findingsPage([], {
        page: 1,
        checkedInPage: 100,
        checkedThrough: 100,
        totalCandidates: 260,
        hasNextPage: true,
      }),
    );
    render(<PublishedAssignmentRepairsPage />);

    expect(
      await screen.findByText("Nothing wrong in the assignments checked so far"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No invalid published assignments"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more findings" })).toBeInTheDocument();
  });

  it("only calls the collection clean once every candidate has been checked", async () => {
    vi.mocked(fetchPublishedAssignmentRepairFindings).mockResolvedValue(
      findingsPage([], {
        page: 1,
        checkedInPage: 129,
        checkedThrough: 129,
        totalCandidates: 129,
        hasNextPage: false,
      }),
    );
    render(<PublishedAssignmentRepairsPage />);

    expect(await screen.findByText("No invalid published assignments")).toBeInTheDocument();
    expect(
      screen.getByText(/checked all 129 published assignments/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more findings" })).not.toBeInTheDocument();
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
    expect(within(preview).getByText("09:00–10:00")).toBeInTheDocument();
    expect(within(preview).getByText("A Perera, B Silva")).toBeInTheDocument();
    expect(within(preview).getByText("Van DAC-2485")).toBeInTheDocument();
    expect(within(preview).getByText(/driver A Perera/)).toBeInTheDocument();
    expect(within(preview).getByText("Withdraw to Unassigned Visits")).toBeInTheDocument();
    expect(within(preview).getByText("NO_AUTHORIZED_DRIVER")).toBeInTheDocument();
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

  it("acknowledges the current day on apply whenever the server scoped a plan item to today", async () => {
    vi.mocked(buildPublishedAssignmentRepairPlan).mockResolvedValue(plan);
    vi.mocked(applyPublishedAssignmentRepair).mockResolvedValue({
      repairId: "repair-2",
      planHash: plan.planHash,
      idempotencyKey: "browser-key",
      communicationState: "APPLIED_PENDING_COMMUNICATION",
      items: [],
    });
    const user = await renderPage();

    await user.click(screen.getByLabelText(/Select City Hotel/));
    await user.click(screen.getByLabelText(/Select Harbour Offices/));
    await user.click(screen.getByRole("checkbox", { name: /I understand today.s dispatched work/i }));
    await user.click(screen.getByRole("button", { name: "Build repair plan" }));

    const applyButton = await screen.findByRole("button", { name: "Apply repair" });
    fireEvent.change(screen.getByLabelText("Repair reason"), {
      target: { value: "Correct today's stranded crew" },
    });
    await user.click(
      screen.getByRole("checkbox", { name: /I confirm this will supersede published assignments/i }),
    );
    await user.click(applyButton);

    expect(vi.mocked(applyPublishedAssignmentRepair).mock.calls[0][0]).toMatchObject({
      acknowledgeCurrentDay: true,
    });
  });

  it("never claims a current-day acknowledgement the plan does not need", async () => {
    vi.mocked(buildPublishedAssignmentRepairPlan).mockResolvedValue({
      ...plan,
      items: [plan.items[0]],
      operations: [plan.operations[0]],
    });
    vi.mocked(applyPublishedAssignmentRepair).mockResolvedValue({
      repairId: "repair-3",
      planHash: plan.planHash,
      idempotencyKey: "browser-key",
      communicationState: "APPLIED_PENDING_COMMUNICATION",
      items: [],
    });
    const user = await renderPage();

    await user.click(screen.getByLabelText(/Select Harbour Offices/));
    await user.click(screen.getByRole("button", { name: "Build repair plan" }));

    fireEvent.change(await screen.findByLabelText("Repair reason"), {
      target: { value: "Correct a future allocation" },
    });
    await user.click(
      screen.getByRole("checkbox", { name: /I confirm this will supersede published assignments/i }),
    );
    await user.click(screen.getByRole("button", { name: "Apply repair" }));

    expect(vi.mocked(applyPublishedAssignmentRepair).mock.calls[0][0]).not.toHaveProperty(
      "acknowledgeCurrentDay",
    );
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
