import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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
  fetchAuthorizedDrivers,
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
  buildAuthorizedDrivers,
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

// Kept in sync with the API's PUBLISHED_HISTORY in
// apps/api/src/scheduling/optimizer/schedule-visit-lock.ts. The assignment
// editor must not offer actions the API will reject for publication history.
const publicationHistoryStatuses = [
  "PUBLISHED",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "COMPLETED",
  "SUPERSEDED",
] as const;

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
  // Default: no authorized drivers for anyone, for any vehicle. The drawer
  // now fetches this eagerly for every vehicle row it renders (not just one
  // the manager just picked), so every test needs a resolvable default —
  // individual tests override it when the driver list itself is what's
  // being exercised.
  vi.mocked(fetchAuthorizedDrivers).mockResolvedValue(buildAuthorizedDrivers({ drivers: [] }));
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
  // UAT on staging: every imported vehicle has no recorded branch, because the
  // Technician Matrix never states one. The drawer asked the API for vehicles
  // *of* the visit's branch and got none, so "Choose a vehicle" opened an
  // empty popup — an enabled control that silently did nothing. The engine's
  // rule is that an unknown branch is unknown, not wrong, and the picker must
  // ask the same question the engine answers.
  it("asks for vehicles that can serve the visit's branch, not only those recorded in it", async () => {
    await openDrawer();

    expect(fetchVehicles).toHaveBeenCalledWith(
      expect.objectContaining({ servesBranch: "COLOMBO" })
    );
    expect(vi.mocked(fetchVehicles).mock.calls[0][0]).not.toHaveProperty("branch");
  });

  it("opens the vehicle picker by mouse, lists vehicles by name, and selects one", async () => {
    vi.mocked(fetchVehicles).mockResolvedValue({
      items: [
        buildVehicle({ id: "vehicle-1", label: "Van 253-4289", branchCode: "COLOMBO" }),
        buildVehicle({ id: "vehicle-2", label: "Bolero DAC-2485", branchCode: null }),
      ],
      total: 2,
      page: 1,
      pageSize: 200,
    });
    vi.mocked(fetchAuthorizedDrivers).mockResolvedValue(
      buildAuthorizedDrivers({
        vehicle: { id: "vehicle-2", code: "DAC-2485", label: "Bolero DAC-2485", seatCapacity: 4 },
        drivers: [
          {
            id: "employee-supervisor",
            fullName: "A Perera",
            gradeLabel: "SPMS",
            isPmsGrade: true,
            branchCode: "COLOMBO",
            deploymentType: "MOBILE",
            isActive: true,
          },
        ],
        total: 1,
      })
    );
    const { user } = await openDrawer();
    await addCrewMember(user, "A Perera");

    await user.click(screen.getByRole("button", { name: "Add vehicle" }));
    await user.click(screen.getByLabelText("Vehicle"));
    expect(await screen.findByRole("option", { name: "Van 253-4289" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Bolero DAC-2485" }));

    expect(screen.getByLabelText("Vehicle")).toHaveTextContent("Bolero DAC-2485");
    await user.click(screen.getByLabelText("Driver"));
    expect(await screen.findByRole("option", { name: "A Perera" })).toBeInTheDocument();
  });

  it("opens the vehicle picker from the keyboard as well", async () => {
    vi.mocked(fetchVehicles).mockResolvedValue({
      items: [buildVehicle({ id: "vehicle-1", label: "Van 253-4289", branchCode: null })],
      total: 1,
      page: 1,
      pageSize: 200,
    });
    const { user } = await openDrawer();
    await addCrewMember(user, "A Perera");

    await user.click(screen.getByRole("button", { name: "Add vehicle" }));
    screen.getByLabelText("Vehicle").focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("option", { name: "Van 253-4289" })).toBeInTheDocument();
  });

  it("explains an empty vehicle list instead of offering a picker that does nothing", async () => {
    vi.mocked(fetchVehicles).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
    const { user } = await openDrawer();
    await addCrewMember(user, "A Perera");

    expect(screen.queryByLabelText("Vehicle")).not.toBeInTheDocument();
    const addVehicle = screen.getByRole("button", { name: "Add vehicle" });
    // Marked, not natively disabled: it stays in the tab order so the reason
    // beside it can actually be reached.
    expect(addVehicle).toHaveAttribute("aria-disabled", "true");
    await user.click(addVehicle);
    expect(screen.queryByLabelText("Vehicle")).not.toBeInTheDocument();
    const explanation = screen.getByRole("status");
    expect(explanation).toHaveTextContent(/No active vehicle can serve COLOMBO work/i);
    expect(explanation).toHaveTextContent(/Record vehicle branches under Vehicles/i);
    expect(addVehicle).toHaveAccessibleDescription(/No active vehicle can serve/i);
  });

  it("names the vehicle a row already holds and does not open it onto an empty list", async () => {
    vi.mocked(fetchVisitAssignment).mockResolvedValue(
      buildAssignment({
        status: "DRAFT",
        vehicles: [
          { vehicleId: "vehicle-held", label: "Van HV-0001", driverEmployeeId: null, driverName: null },
        ],
      })
    );
    vi.mocked(fetchVehicles).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
    const { user } = await openDrawer();

    const vehicleControl = await screen.findByLabelText("Vehicle");
    expect(vehicleControl).toHaveTextContent("Van HV-0001");
    expect(vehicleControl).toBeDisabled();
    await user.click(vehicleControl);
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/already on this assignment/i);
  });

  it("keeps the explanation out of read-only publication history", async () => {
    vi.mocked(fetchVisitAssignment).mockResolvedValue(buildAssignment({ status: "PUBLISHED" }));
    vi.mocked(fetchVehicles).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
    await openDrawer();
    await screen.findByLabelText("Vehicle");

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("names crew members and drivers from the assignment even when the lists no longer return them", async () => {
    vi.mocked(fetchVisitAssignment).mockResolvedValue(
      buildAssignment({
        status: "PUBLISHED",
        crew: [
          { employeeId: "employee-gone", fullName: "R Silva", role: "SUPERVISOR", isPmsSupervisor: true },
        ],
        vehicles: [
          {
            vehicleId: "vehicle-1",
            label: "Van 253-4289",
            driverEmployeeId: "employee-gone",
            driverName: "R Silva",
          },
        ],
      })
    );
    mockEmployeeList([supervisor, technician]);
    vi.mocked(fetchAuthorizedDrivers).mockResolvedValue(buildAuthorizedDrivers({ drivers: [] }));
    await openDrawer();

    expect(await screen.findByLabelText("Employee")).toHaveTextContent("R Silva (PMS)");
    expect(screen.getByLabelText("Driver")).toHaveTextContent("R Silva");
    expect(screen.queryByText(/employee-gone/)).not.toBeInTheDocument();
  });

  // UAT on staging: a published assignment's vehicle showed as a bare UUID.
  // The read model already names the vehicle; the drawer was looking it up
  // only in the currently selectable list, which need not contain it.
  it("names an assigned vehicle from the assignment itself, even when it is not selectable now", async () => {
    vi.mocked(fetchVisitAssignment).mockResolvedValue(
      buildAssignment({
        status: "PUBLISHED",
        vehicles: [
          {
            vehicleId: "fea4792a-c979-49cd-abaa-9aa0ef4ac24f",
            label: "Lorry KX-1010",
            driverEmployeeId: "employee-1",
            driverName: "A Perera",
          },
        ],
      })
    );
    vi.mocked(fetchVehicles).mockResolvedValue({
      items: [buildVehicle({ id: "vehicle-1", label: "Van 253-4289" })],
      total: 1,
      page: 1,
      pageSize: 200,
    });
    await openDrawer();

    const vehicleControl = await screen.findByLabelText("Vehicle");
    expect(vehicleControl).toHaveTextContent("Lorry KX-1010");
    expect(vehicleControl).not.toHaveTextContent("fea4792a");
    expect(screen.queryByText(/fea4792a-c979/)).not.toBeInTheDocument();
  });

  it("does not make a historical vehicle selectable merely to name it", async () => {
    vi.mocked(fetchVisitAssignment).mockResolvedValue(
      buildAssignment({
        status: "DRAFT",
        vehicles: [
          {
            vehicleId: "vehicle-retired",
            label: "Retired Van RX-0001",
            driverEmployeeId: null,
            driverName: null,
          },
        ],
      })
    );
    vi.mocked(fetchVehicles).mockResolvedValue({
      items: [buildVehicle({ id: "vehicle-1", label: "Van 253-4289" })],
      total: 1,
      page: 1,
      pageSize: 200,
    });
    const { user } = await openDrawer();

    const vehicleControl = await screen.findByLabelText("Vehicle");
    expect(vehicleControl).toHaveTextContent("Retired Van RX-0001");
    await user.click(vehicleControl);
    expect(await screen.findByRole("option", { name: "Van 253-4289" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Retired Van RX-0001" })).not.toBeInTheDocument();
  });

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

  /**
   * The reason box reset to its placeholder on save and the edit never
   * appeared in the visit's History, so a manager had no way to tell whether
   * what they were made to write had been kept. It is kept — the drawer
   * clears the box deliberately, because the next change needs its own reason,
   * and the one just given is on the visit's History.
   */
  it("clears the reason after it has been saved, so the next change needs its own", async () => {
    vi.mocked(checkAssignment).mockResolvedValue(buildEligibilityResult({ isEligible: true }));
    vi.mocked(assignCrew).mockResolvedValue(buildAssignment({}));
    const { user } = await openDrawer();

    await addCrewMember(user, "A Perera");
    await screen.findByText("This crew is eligible to take the visit.");
    await user.type(screen.getByLabelText("Reason for this change"), "Customer requested this crew");
    await user.click(screen.getByRole("button", { name: "Save assignment" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Reason for this change")).toHaveValue("")
    );
  });

  /**
   * The coordinator's report: the validation panel said the crew was fine,
   * Save was greyed out, nothing was marked required and nothing explained
   * why — "I would have concluded the system was broken and phoned someone."
   * The reason box was what Save was waiting for.
   */
  it("will not save without a reason, and says that is what it is waiting for", async () => {
    vi.mocked(checkAssignment).mockResolvedValue(buildEligibilityResult({ isEligible: true }));
    const { user } = await openDrawer();

    await addCrewMember(user, "A Perera");
    await screen.findByText("This crew is eligible to take the visit.");

    const saveButton = screen.getByRole("button", { name: "Save assignment" });
    expect(saveButton).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("Add a reason for this change before saving.")
    ).toBeInTheDocument();
    // Named by the button itself, so the reason is announced with it rather
    // than only sitting somewhere on the page.
    expect(saveButton).toHaveAccessibleDescription(
      "Add a reason for this change before saving."
    );

    await user.click(saveButton);
    expect(assignCrew).not.toHaveBeenCalled();
    // And it puts the manager in the box it is waiting for.
    expect(screen.getByLabelText("Reason for this change")).toHaveFocus();
  });

  /**
   * The drawer opened on "Arrives 08:00 / Leaves by 17:00" — the site's whole
   * working day — for a 60-minute job. Save it unchanged and the crew is
   * blocked out for nine hours, and nothing on screen said the numbers were a
   * fallback rather than the plan.
   */
  it("defaults to the visit's own planned window, not the site's whole day", async () => {
    vi.mocked(fetchVisit).mockResolvedValue(
      buildVisitDetail({
        id: "visit-1",
        windowStartMinute: 8 * 60,
        windowEndMinute: 17 * 60,
        durationMinutes: 60,
      })
    );
    vi.mocked(fetchVisitAssignment).mockResolvedValue(null);
    await openDrawer();

    expect(screen.getByLabelText("Arrives")).toHaveValue("08:00");
    expect(screen.getByLabelText("Leaves by")).toHaveValue("09:00");
  });

  it("never defaults past the window the visit has to stay inside", async () => {
    // A window shorter than the job is already flagged elsewhere; the default
    // must not quietly propose a crew leaving after the site shuts.
    vi.mocked(fetchVisit).mockResolvedValue(
      buildVisitDetail({
        id: "visit-1",
        windowStartMinute: 9 * 60,
        windowEndMinute: 10 * 60,
        durationMinutes: 180,
      })
    );
    vi.mocked(fetchVisitAssignment).mockResolvedValue(null);
    await openDrawer();

    expect(screen.getByLabelText("Leaves by")).toHaveValue("10:00");
  });

  it("marks the reason box required where it is asked for", async () => {
    const { user } = await openDrawer();
    await addCrewMember(user, "A Perera");

    const box = screen.getByLabelText("Reason for this change");
    expect(box).toBeRequired();
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  it("says which step is missing when there is no crew yet", async () => {
    await openDrawer();

    expect(screen.getByRole("button", { name: "Save assignment" })).toHaveAccessibleDescription(
      "Add at least one crew member before saving."
    );
  });

  it("names the failed validation as the blocker, not silence", async () => {
    vi.mocked(checkAssignment).mockResolvedValue(
      buildEligibilityResult({
        isEligible: false,
        conflicts: [buildConflict({ code: "BRANCH_MISMATCH", message: "Wrong branch." })],
      })
    );
    const { user } = await openDrawer();

    await addCrewMember(user, "A Perera");
    await screen.findByText("Wrong branch.");
    await user.type(screen.getByLabelText("Reason for this change"), "Because");

    expect(screen.getByRole("button", { name: "Save assignment" })).toHaveAccessibleDescription(
      "This crew cannot take the visit yet — see Validation below."
    );
  });

  it("never leaves Save dead and silent", async () => {
    // Whatever is missing, the button that cannot be pressed says why.
    vi.mocked(checkAssignment).mockResolvedValue(buildEligibilityResult({ isEligible: true }));
    const { user } = await openDrawer();

    const saveButton = screen.getByRole("button", { name: "Save assignment" });
    expect(saveButton).toHaveAccessibleDescription(/\S/);

    await addCrewMember(user, "A Perera");
    await screen.findByText("This crew is eligible to take the visit.");
    expect(saveButton).toHaveAccessibleDescription(/\S/);

    await user.type(screen.getByLabelText("Reason for this change"), "Customer requested this crew");
    // Nothing missing: no aria-disabled, and nothing left to explain.
    expect(saveButton).not.toHaveAttribute("aria-disabled");
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
    expect(screen.getByRole("button", { name: "Save assignment" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("offers only crew members who are also authorized for the vehicle as driver choices (ULK-O09)", async () => {
    vi.mocked(fetchVisitAssignment).mockResolvedValue(
      buildAssignment({
        id: "assignment-driver-1",
        crew: [
          { employeeId: supervisor.id, fullName: supervisor.fullName, role: "SUPERVISOR", isPmsSupervisor: true },
          { employeeId: technician.id, fullName: technician.fullName, role: "TECHNICIAN", isPmsSupervisor: false },
        ],
        vehicles: [
          { vehicleId: "vehicle-1", label: "Van 253-4289", driverEmployeeId: null, driverName: null },
        ],
      })
    );
    vi.mocked(fetchAuthorizedDrivers).mockResolvedValue(
      buildAuthorizedDrivers({
        // The supervisor is authorized and on the crew (eligible). The
        // technician is on the crew but not authorized (must not appear).
        // "Z Outsider" is authorized but not on this visit's crew at all
        // (must not appear either) — offering them would let a manager
        // assign someone who isn't even part of the visit.
        drivers: [
          {
            id: supervisor.id,
            fullName: supervisor.fullName,
            gradeLabel: "PMS",
            isPmsGrade: true,
            branchCode: "COLOMBO",
            deploymentType: "MOBILE",
            isActive: true,
          },
          {
            id: "employee-outsider",
            fullName: "Z Outsider",
            gradeLabel: "Technician",
            isPmsGrade: false,
            branchCode: "COLOMBO",
            deploymentType: "MOBILE",
            isActive: true,
          },
        ],
      })
    );

    const { user } = await openDrawer();
    await screen.findByLabelText("Driver");

    await user.click(screen.getByLabelText("Driver"));

    expect(await screen.findByRole("option", { name: "A Perera" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Fernando/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Outsider/ })).not.toBeInTheDocument();
  });

  it("clears an assigned driver the moment they're removed from the crew (ULK-O09)", async () => {
    vi.mocked(fetchVisitAssignment).mockResolvedValue(
      buildAssignment({
        id: "assignment-driver-2",
        crew: [
          { employeeId: supervisor.id, fullName: supervisor.fullName, role: "SUPERVISOR", isPmsSupervisor: true },
          { employeeId: technician.id, fullName: technician.fullName, role: "TECHNICIAN", isPmsSupervisor: false },
        ],
        vehicles: [
          {
            vehicleId: "vehicle-1",
            label: "Van 253-4289",
            driverEmployeeId: supervisor.id,
            driverName: supervisor.fullName,
          },
        ],
      })
    );
    vi.mocked(fetchAuthorizedDrivers).mockResolvedValue(
      buildAuthorizedDrivers({
        drivers: [
          {
            id: supervisor.id,
            fullName: supervisor.fullName,
            gradeLabel: "PMS",
            isPmsGrade: true,
            branchCode: "COLOMBO",
            deploymentType: "MOBILE",
            isActive: true,
          },
        ],
      })
    );

    await openDrawer();
    const driverTrigger = await screen.findByLabelText("Driver");
    expect(driverTrigger).toHaveTextContent("A Perera");

    // Remove the supervisor — the first "Remove crew member" button, since
    // crew rows render in the same order as the crew array above.
    await userEvent.click(screen.getAllByRole("button", { name: "Remove crew member" })[0]);

    // The saved driver was the person just removed, and they're no longer
    // on the crew at all — the row has to fall back to "unset", not keep
    // showing a driver who isn't part of this visit anymore.
    expect(driverTrigger).not.toHaveTextContent("A Perera");
    expect(driverTrigger).toHaveTextContent("No crew member is authorized");
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

  it.each(publicationHistoryStatuses)(
    "makes a %s publication-history assignment fully read-only",
    async (status) => {
      vi.mocked(fetchVisitAssignment).mockResolvedValue(buildAssignment({ status }));

      await openDrawer();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(await screen.findByLabelText("Arrives")).toBeDisabled();
      expect(checkAssignment).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Leaves by")).toBeDisabled();
      expect(screen.getByLabelText("Employee")).toBeDisabled();
      expect(screen.getByLabelText("Role")).toBeDisabled();
      expect(screen.getByLabelText("Vehicle")).toBeDisabled();
      expect(screen.getByLabelText("Driver")).toBeDisabled();
      expect(screen.getByLabelText("Reason for this change")).toBeDisabled();

      expect(screen.getByRole("button", { name: "Add crew member" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Remove crew member" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add vehicle" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Remove vehicle" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Remove crew" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Save assignment" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
      for (const { label } of [
        { label: "Date & time" },
        { label: "Supervisor" },
        { label: "Crew" },
        { label: "Vehicle" },
        { label: "Everything" },
      ]) {
        expect(screen.getByRole("button", { name: label })).toBeDisabled();
      }
      expect(screen.getByText("Supervisor & crew").closest("div.overflow-y-auto")).toHaveAttribute(
        "tabindex",
        "0"
      );
    }
  );

  it.each(["DRAFT", "PROPOSED"] as const)(
    "keeps a %s assignment editable",
    async (status) => {
      vi.mocked(fetchVisitAssignment).mockResolvedValue(buildAssignment({ status }));
      vi.mocked(checkAssignment).mockResolvedValue(buildEligibilityResult({ isEligible: true }));
      const { user } = await openDrawer();

      await screen.findByText("This crew is eligible to take the visit.");
      await user.type(screen.getByLabelText("Reason for this change"), "Confirmed with customer");

      expect(screen.getByLabelText("Employee")).not.toBeDisabled();
      expect(screen.getByLabelText("Reason for this change")).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "Crew" })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "Remove crew" })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: "Save assignment" })).not.toBeDisabled();
    }
  );

  it("keeps the current ineligible proposal blocked when an older eligibility request resolves late", async () => {
    let resolveOlder: ((result: ReturnType<typeof buildEligibilityResult>) => void) | undefined;
    let resolveCurrent: ((result: ReturnType<typeof buildEligibilityResult>) => void) | undefined;
    vi.mocked(checkAssignment).mockImplementation(
      () =>
        new Promise((resolve) => {
          if (resolveOlder) resolveCurrent = resolve;
          else resolveOlder = resolve;
        })
    );
    const { user } = await openDrawer();

    await addCrewMember(user, "A Perera");
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(checkAssignment).toHaveBeenCalledTimes(1);

    await user.click(screen.getByLabelText("Employee"));
    await user.click(await screen.findByRole("option", { name: /N Fernando/ }));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(checkAssignment).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveCurrent?.(
        buildEligibilityResult({
          isEligible: false,
          conflicts: [buildConflict({ code: "CREW_TOO_SMALL", message: "The replacement crew is invalid." })],
        })
      );
    });
    await user.type(screen.getByLabelText("Reason for this change"), "Trying another crew");
    expect(await screen.findByText("The replacement crew is invalid.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save assignment" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await act(async () => {
      resolveOlder?.(buildEligibilityResult({ isEligible: true }));
    });

    expect(screen.getByText("The replacement crew is invalid.")).toBeInTheDocument();
    expect(screen.queryByText("This crew is eligible to take the visit.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save assignment" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps the reason when a save is refused, so nobody retypes it", async () => {
    vi.mocked(checkAssignment).mockResolvedValue(buildEligibilityResult({ isEligible: true }));
    vi.mocked(assignCrew).mockRejectedValue(
      new ApiError({ code: "RESOURCE_CONFLICT", message: "Somebody else changed this." })
    );
    const { user } = await openDrawer();

    await addCrewMember(user, "A Perera");
    await screen.findByText("This crew is eligible to take the visit.");
    await user.type(screen.getByLabelText("Reason for this change"), "Emergency cover");
    await user.click(screen.getByRole("button", { name: "Save assignment" }));

    expect(screen.getByLabelText("Reason for this change")).toHaveValue("Emergency cover");
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

  it("collapses a rapid double-click on Save into a single request", async () => {
    vi.mocked(checkAssignment).mockResolvedValue(buildEligibilityResult({ isEligible: true }));
    let resolveAssign: (() => void) | undefined;
    vi.mocked(assignCrew).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAssign = () =>
            resolve(
              buildAssignment({
                crew: [{ employeeId: supervisor.id, fullName: supervisor.fullName, role: "SUPERVISOR", isPmsSupervisor: true }],
              })
            );
        })
    );
    const { user } = await openDrawer();

    await addCrewMember(user, "A Perera");
    await screen.findByText("This crew is eligible to take the visit.");
    await user.type(screen.getByLabelText("Reason for this change"), "Customer requested this crew");

    const button = screen.getByRole("button", { name: "Save assignment" });
    // Two clicks fired without awaiting between them — a genuine double-click,
    // not two sequential, fully-settled ones.
    await userEvent.click(button, { skipHover: true });
    await userEvent.click(button, { skipHover: true });

    expect(assignCrew).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveAssign?.();
    });
  });
});
