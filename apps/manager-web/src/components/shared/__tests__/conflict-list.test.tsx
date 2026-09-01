import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { ConflictList } from "@/components/shared/conflict-list";
import { CONFLICT_GROUP_LABEL } from "@/lib/conflict-groups";
import type { Conflict, ConflictCode } from "@/lib/api-client";
import { buildConflict } from "@/test/fixtures";

/** One real code per named group, so each of the 10 gets its own presentation test. */
const GROUP_EXAMPLES: Array<{ group: string; code: ConflictCode; message: string }> = [
  { group: "MISSING_PMS", code: "BRANCH_HAS_NO_PMS_SUPERVISOR", message: "No PMS supervisor available in this branch." },
  { group: "INSUFFICIENT_CREW", code: "CREW_TOO_SMALL", message: "Only 1 of the 2 required crew members were proposed." },
  { group: "MISSING_SKILL", code: "SKILL_NOT_HELD", message: "No proposed crew member holds the Fumigation skill." },
  { group: "NO_AUTHORIZED_DRIVER", code: "NO_AUTHORIZED_DRIVER", message: "No proposed crew member is authorized to drive this vehicle." },
  { group: "UNAVAILABLE_VEHICLE", code: "VEHICLE_INACTIVE", message: "This vehicle is inactive." },
  { group: "BRANCH_RESTRICTION", code: "BRANCH_MISMATCH", message: "This employee's branch does not match the visit's branch." },
  { group: "PERMANENT_STAFF_RESTRICTION", code: "EMPLOYEE_PERMANENTLY_STATIONED", message: "This employee is permanently stationed elsewhere." },
  { group: "SERVICE_WINDOW_CONFLICT", code: "OUTSIDE_SERVICE_HOURS", message: "This visit falls outside the site's opening hours." },
  { group: "EMPLOYEE_OVERLAP", code: "EMPLOYEE_DOUBLE_BOOKED", message: "This employee is already assigned to another visit at this time." },
  { group: "VEHICLE_OVERLAP", code: "VEHICLE_DOUBLE_BOOKED", message: "This vehicle is already assigned to another visit at this time." },
];

describe("ConflictList", () => {
  it.each(GROUP_EXAMPLES)(
    "presents a $group conflict with its group label, code, and message",
    ({ group, code, message }) => {
      const conflict = buildConflict({ code, message, remediation: "Fix it." });
      render(<ConflictList conflicts={[conflict]} />);

      expect(screen.getByText(CONFLICT_GROUP_LABEL[group as keyof typeof CONFLICT_GROUP_LABEL])).toBeInTheDocument();
      expect(screen.getByText(code)).toBeInTheDocument();
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.getByText("Fix it.")).toBeInTheDocument();
    }
  );

  it("displays every returned conflict, not only the first", () => {
    const conflicts: Conflict[] = [
      buildConflict({ code: "CREW_TOO_SMALL", message: "First problem." }),
      buildConflict({ code: "SKILL_NOT_HELD", message: "Second problem." }),
      buildConflict({ code: "VEHICLE_DOUBLE_BOOKED", message: "Third problem." }),
    ];
    render(<ConflictList conflicts={conflicts} />);

    expect(screen.getByText("First problem.")).toBeInTheDocument();
    expect(screen.getByText("Second problem.")).toBeInTheDocument();
    expect(screen.getByText("Third problem.")).toBeInTheDocument();
  });

  it("does not rely on color alone: every conflict carries a text label and code beside its icon", () => {
    const conflict = buildConflict({ code: "BRANCH_HAS_NO_PMS_SUPERVISOR" });
    render(<ConflictList conflicts={[conflict]} />);

    const item = screen.getByText("BRANCH_HAS_NO_PMS_SUPERVISOR").closest("li")!;
    // The icon is decorative — hidden from assistive tech — because the
    // adjacent text badge and stable code are the real signal.
    const icon = item.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(within(item).getByText("Missing PMS supervisor")).toBeInTheDocument();
  });

  it("links each named resource to its own record", () => {
    const conflict = buildConflict({
      code: "CREW_TOO_SMALL",
      resources: {
        visitId: "visit-1",
        employeeIds: ["employee-9"],
        vehicleIds: ["vehicle-4"],
        serviceSiteId: "site-1",
        skillCodes: [],
        assignmentIds: [],
      },
    });
    render(<ConflictList conflicts={[conflict]} />);

    expect(screen.getByRole("button", { name: /View employee/ })).toHaveAttribute(
      "href",
      "/workforce/employee-9"
    );
    expect(screen.getByRole("button", { name: /View vehicle/ })).toHaveAttribute(
      "href",
      "/vehicles/vehicle-4"
    );
  });
});
