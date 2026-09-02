import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchVisit: vi.fn(),
    fetchVisitAssignment: vi.fn(),
    fetchEmployees: vi.fn(),
    fetchVehicles: vi.fn(),
    fetchAuthorizedDrivers: vi.fn(),
    checkAssignment: vi.fn(),
    assignCrew: vi.fn(),
    unassignVisit: vi.fn(),
    lockAssignment: vi.fn(),
    unlockAssignment: vi.fn(),
  };
});

import { AssignmentEditorDrawer } from "../assignment-editor-drawer";
import {
  ApiError,
  assignCrew,
  checkAssignment,
  fetchEmployees,
  fetchVehicles,
  fetchVisit,
  fetchVisitAssignment,
  lockAssignment,
  type Employee,
} from "@/lib/api-client";
import {
  buildAssignment,
  buildAssignmentLock,
  buildConflict,
  buildEligibilityResult,
  buildEmployee,
  buildVehicle,
  buildVisitDetail,
} from "@/test/fixtures";

const supervisor = buildEmployee({
  id: "employee-supervisor",
  fullName: "A Perera",
  isPmsGrade: true,
  branchCode: "COLOMBO",
});
const technician = buildEmployee({
  id: "employee-technician",
  fullName: "N Fernando",
  isPmsGrade: false,
  branchCode: "COLOMBO",
});

function mockEmployeeList(items: Employee[] = [supervisor, technician]) {
  vi.mocked(fetchEmployees).mockResolvedValue({ items, total: items.length, page: 1, pageSize: 200 });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });

  vi.mocked(fetchVisit).mockResolvedValue(
    buildVisitDetail({
      id: "visit-1",
      customerName: "Cinnamon Grand Colombo",
      branchCode: "COLOMBO",
      windowStartMinute: 540,
      windowEndMinute: 1020,
    })
  );
  vi.mocked(fetchVisitAssignment).mockResolvedValue(null);
  mockEmployeeList();
  vi.mocked(fetchVehicles).mockResolvedValue({
    items: [buildVehicle({ id: "vehicle-1", label: "Van 253-4289" })],
    total: 1,
    page: 1,
    pageSize: 200,
  });
  vi.mocked(checkAssignment).mockReset();
  vi.mocked(assignCrew).mockReset();
  vi.mocked(lockAssignment).mockReset();
});

async function openDrawer() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const onChanged = vi.fn();
  render(
    <AssignmentEditorDrawer visitId="visit-1" onOpenChange={() => {}} onChanged={onChanged} />
  );
  await screen.findByText("Edit crew — Cinnamon Grand Colombo");
  return { user, onChanged };
}

async function addCrewMember(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: "Add crew member" }));
  await user.click(screen.getByLabelText("Employee"));
  await user.click(await screen.findByRole("option", { name: new RegExp(name) }));
}

describe("AssignmentEditorDrawer", () => {
  it("is an accessible replacement workflow: every control has a real label", async () => {
    const { user } = await openDrawer();
    await addCrewMember(user, "A Perera");

    expect(screen.getByLabelText("Arrives")).toBeInTheDocument();
    expect(screen.getByLabelText("Leaves by")).toBeInTheDocument();
    expect(screen.getByLabelText("Employee")).toBeInTheDocument();
    expect(screen.getByLabelText("Role")).toBeInTheDocument();
    expect(screen.getByLabelText("Reason for this change")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add vehicle" })).toBeInTheDocument();
  });

  it("saves a valid replacement once the crew checks out and a reason is given", async () => {
    vi.mocked(checkAssignment).mockResolvedValue(buildEligibilityResult({ isEligible: true }));
    vi.mocked(assignCrew).mockResolvedValue(
      buildAssignment({ crew: [{ employeeId: supervisor.id, fullName: supervisor.fullName, role: "SUPERVISOR", isPmsSupervisor: true }] })
    );
    const { user, onChanged } = await openDrawer();

    await addCrewMember(user, "A Perera");

    expect(
      await screen.findByText("This crew is eligible to take the visit.")
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Reason for this change"), "Customer requested this crew");
    await user.click(screen.getByRole("button", { name: "Save assignment" }));

    expect(assignCrew).toHaveBeenCalledWith(
      "visit-1",
      expect.objectContaining({ reason: "Customer requested this crew" })
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("will not save without a reason", async () => {
    vi.mocked(checkAssignment).mockResolvedValue(buildEligibilityResult({ isEligible: true }));
    const { user } = await openDrawer();

    await addCrewMember(user, "A Perera");
    await screen.findByText("This crew is eligible to take the visit.");

    expect(screen.getByRole("button", { name: "Save assignment" })).toBeDisabled();
  });

  it("shows every rejection reason for an invalid move, and blocks Save", async () => {
    vi.mocked(checkAssignment).mockResolvedValue(
      buildEligibilityResult({
        isEligible: false,
        conflicts: [
          buildConflict({
            code: "BRANCH_MISMATCH",
            message: "This employee's branch does not match the visit's branch.",
          }),
          buildConflict({
            code: "NO_PMS_SUPERVISOR_AVAILABLE",
            message: "No PMS-grade supervisor is available for this visit.",
          }),
          buildConflict({
            code: "VEHICLE_INACTIVE",
            message: "This vehicle is inactive.",
          }),
          buildConflict({
            code: "EMPLOYEE_PERMANENTLY_STATIONED",
            message: "This employee is permanently stationed elsewhere.",
          }),
        ],
      })
    );
    const { user } = await openDrawer();

    await addCrewMember(user, "N Fernando");
    await user.type(screen.getByLabelText("Reason for this change"), "Trying a swap");

    expect(
      await screen.findByText("This employee's branch does not match the visit's branch.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("No PMS-grade supervisor is available for this visit.")
    ).toBeInTheDocument();
    expect(screen.getByText("This vehicle is inactive.")).toBeInTheDocument();
    expect(
      screen.getByText("This employee is permanently stationed elsewhere.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save assignment" })).toBeDisabled();
  });

  it("pins a scope for this session and shows it as pinned", async () => {
    vi.mocked(fetchVisitAssignment).mockResolvedValue(
      buildAssignment({ id: "assignment-9", isLocked: false })
    );
    vi.mocked(lockAssignment).mockResolvedValue(
      buildAssignmentLock({ assignmentId: "assignment-9", scope: "CREW" })
    );
    vi.spyOn(window, "prompt").mockReturnValue("Customer asked for this crew");
    const { user } = await openDrawer();

    const crewLockButton = await screen.findByRole("button", { name: "Crew" });
    await user.click(crewLockButton);

    expect(lockAssignment).toHaveBeenCalledWith("assignment-9", {
      scope: "CREW",
      reason: "Customer asked for this crew",
    });
    // Pinned now shows the "unpin" icon instead of "pin" — the session's own
    // record of what it just locked, since the API can't be asked which
    // scopes are locked (see the note in api-client.ts).
    const pinnedButton = await screen.findByRole("button", { name: "Crew" });
    expect(pinnedButton.querySelector("svg")).toHaveClass("lucide-pin-off");
  });

  it("surfaces a backend refusal without losing the drawer", async () => {
    vi.mocked(checkAssignment).mockResolvedValue(buildEligibilityResult({ isEligible: true }));
    vi.mocked(assignCrew).mockRejectedValue(
      new ApiError({
        code: "ASSIGNMENT_NOT_ELIGIBLE",
        message: "This crew cannot take the visit.",
        details: {
          conflicts: [
            buildConflict({ code: "CREW_TOO_SMALL", message: "Only 1 of 2 required crew were proposed." }),
          ],
        },
      })
    );
    const { user } = await openDrawer();

    await addCrewMember(user, "A Perera");
    await screen.findByText("This crew is eligible to take the visit.");
    await user.type(screen.getByLabelText("Reason for this change"), "Emergency cover");
    await user.click(screen.getByRole("button", { name: "Save assignment" }));

    expect(
      await screen.findByText("Only 1 of 2 required crew were proposed.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save assignment" })).toBeInTheDocument();
  });
});
