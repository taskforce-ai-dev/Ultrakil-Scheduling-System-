import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The queue reads ?visit=<id> to open on one visit. Kept switchable so the
// "asked for by name" path can be exercised alongside the filter tests.
const { searchParamsRef } = vi.hoisted(() => ({
  searchParamsRef: { current: null as URLSearchParams | null },
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return { ...actual, useSearchParams: () => searchParamsRef.current };
});

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchUnassignedVisits: vi.fn(),
    fetchVisit: vi.fn(),
    lockVisit: vi.fn(),
    unlockVisit: vi.fn(),
  };
});

import UnassignedVisitsPage from "../page";
import { ApiError, fetchUnassignedVisits, type UnassignedVisit } from "@/lib/api-client";
import { buildConflict, buildUnassignedVisit } from "@/test/fixtures";

const kandyNoSupervisor = buildUnassignedVisit({
  visitId: "visit-kandy",
  branchCode: "KANDY",
  customerName: "Grandview Hotel",
  siteName: "Main Kitchen",
  requiredCrewSize: 2,
  conflicts: [
    buildConflict({
      code: "BRANCH_HAS_NO_PMS_SUPERVISOR",
      message: "No PMS-grade supervisor is available in Kandy for this visit.",
      remediation: "Assign a Kandy PMS supervisor, or wait until one becomes available.",
      resources: {
        visitId: "visit-kandy",
        employeeIds: [],
        vehicleIds: [],
        serviceSiteId: "site-kandy",
        skillCodes: [],
        assignmentIds: [],
      },
    }),
  ],
});

const colomboCrewTooSmall = buildUnassignedVisit({
  visitId: "visit-colombo",
  branchCode: "COLOMBO",
  customerName: "Cinnamon Grand Colombo",
  siteName: "Main Kitchen",
  requiredCrewSize: 3,
  conflicts: [
    buildConflict({
      code: "CREW_TOO_SMALL",
      message: "Only 1 of the 3 required crew members were proposed.",
      remediation: "Add more crew to the assignment.",
      resources: {
        visitId: "visit-colombo",
        employeeIds: ["employee-9"],
        vehicleIds: [],
        serviceSiteId: "site-colombo",
        skillCodes: [],
        assignmentIds: [],
      },
    }),
    buildConflict({
      code: "SKILL_NOT_HELD",
      message: "No proposed crew member holds the Fumigation skill.",
      remediation: "Assign a crew member who holds this skill.",
      resources: {
        visitId: "visit-colombo",
        employeeIds: [],
        vehicleIds: [],
        serviceSiteId: "site-colombo",
        skillCodes: ["FUMIGATION"],
        assignmentIds: [],
      },
    }),
  ],
});

function mockUnassigned(items: UnassignedVisit[], total = items.length) {
  vi.mocked(fetchUnassignedVisits).mockResolvedValue({
    items,
    total,
    page: 1,
    pageSize: 200,
    hasNextPage: false,
    conflictFacets: {},
  });
}

beforeEach(() => {
  searchParamsRef.current = null;
  mockUnassigned([kandyNoSupervisor, colomboCrewTooSmall]);
});

async function renderPage() {
  const user = userEvent.setup();
  render(<UnassignedVisitsPage />);
  await screen.findByText("Grandview Hotel");
  return user;
}

describe("unassigned visits queue", () => {
  it("displays every returned conflict, not only the first", async () => {
    await renderPage();

    const row = screen.getByText("Cinnamon Grand Colombo").closest("li")!;
    expect(within(row).getByText(/Only 1 of the 3 required crew members/)).toBeInTheDocument();
    expect(within(row).getByText(/No proposed crew member holds the Fumigation skill/)).toBeInTheDocument();
  });

  it("makes the Kandy PMS supervisor shortage explicit", async () => {
    await renderPage();

    expect(screen.getByText("Kandy has no PMS supervisor available")).toBeInTheDocument();
  });

  it("stays quiet about the Kandy banner when no such conflict is returned", async () => {
    mockUnassigned([colomboCrewTooSmall]);
    render(<UnassignedVisitsPage />);
    await screen.findByText("Cinnamon Grand Colombo");

    expect(screen.queryByText("Kandy has no PMS supervisor available")).not.toBeInTheDocument();
  });

  it("gives a direct path from a conflict to the resource it names", async () => {
    await renderPage();

    const row = screen.getByText("Cinnamon Grand Colombo").closest("li")!;
    const link = within(row).getByRole("button", { name: /View employee/ });
    expect(link).toHaveAttribute("href", "/workforce/employee-9");
  });

  it("filters by branch", async () => {
    const user = await renderPage();

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    const lastCall = vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ branchCode: "KANDY" });
  });

  it("returns to the first server page when the branch changes", async () => {
    mockUnassigned([kandyNoSupervisor, colomboCrewTooSmall], 640);
    const user = await renderPage();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0]).toMatchObject({ page: 2 });

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    expect(vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0]).toMatchObject({
      branchCode: "KANDY",
      page: 1,
    });
  });

  it("asks the server for a conflict group instead of filtering in the browser", async () => {
    // The group goes to the server as `conflictGroup` — the filter it
    // validates — and never as `conflictCode`, which is the engine's own
    // vocabulary and rejects a group label outright.
    const user = await renderPage();

    await user.click(screen.getByLabelText("Conflict type"));
    await user.click(await screen.findByRole("option", { name: "Missing skill" }));

    const lastCall = vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ conflictGroup: "MISSING_SKILL", page: 1 });
    expect(lastCall).not.toHaveProperty("conflictCode");
    expect(lastCall).not.toHaveProperty("status");
  });

  it("shows what the server returned for a conflict group, unfiltered", async () => {
    // Whatever the server sends back is what the list shows: re-filtering it
    // here would leave the rows disagreeing with the total beside them.
    const user = await renderPage();

    await user.click(screen.getByLabelText("Conflict type"));
    await user.click(await screen.findByRole("option", { name: "Missing skill" }));

    expect(await screen.findByText("Cinnamon Grand Colombo")).toBeInTheDocument();
    expect(screen.getByText("Grandview Hotel")).toBeInTheDocument();
  });

  /**
   * "Narrow the branch filter to see the rest" was advice that could not
   * work — everything in the pilot is one branch — and it never mentioned
   * the pager at the very bottom, which is the actual way to see rows 26
   * onwards.
   */
  it("says how to reach the rest of the queue: the pager, not the branch", async () => {
    mockUnassigned([kandyNoSupervisor, colomboCrewTooSmall], 70);
    render(<UnassignedVisitsPage />);
    await screen.findByText("Grandview Hotel");

    expect(screen.getByText(/Showing 2 of 70 unassigned visits/)).toBeInTheDocument();
    expect(screen.getByText(/pager at the end of this list/)).toBeInTheDocument();
    expect(screen.queryByText(/Narrow the branch filter/)).not.toBeInTheDocument();
  });

  /**
   * The pager, walked end to end on a backlog that actually needs one.
   *
   * The pilot dataset has 23 unassigned visits, so the queue never went past
   * one page in the trial and the pager the banner points at was never
   * exercised by anyone. 70 visits at 25 a page is three pages: the banner
   * and the pager have to agree about which one of them a manager is on, and
   * the ends have to stop — a Previous that steps off page 1, or a Next that
   * asks the server for page 4 of 3, both answer with an empty list and no
   * way to tell that from "nothing left to staff".
   */
  it("walks a backlog too large for one page, and stops at both ends", async () => {
    mockUnassigned([kandyNoSupervisor, colomboCrewTooSmall], 70);
    render(<UnassignedVisitsPage />);
    await screen.findByText("Grandview Hotel");
    const user = userEvent.setup();

    // Re-queried each time: every page change puts the list back through its
    // loading state, so the pager is a new node afterwards.
    const pager = () => screen.getByRole("navigation", { name: "Unassigned visit pages" });
    const lastQuery = () => vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0];

    // Banner and pager, one page number between them.
    expect(screen.getByText(/page 1 of 3\./)).toBeInTheDocument();
    expect(within(pager()).getByText(/Page 1 of 3/)).toBeInTheDocument();
    expect(within(pager()).getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(within(pager()).getByRole("button", { name: "Next" })).toBeEnabled();

    await user.click(within(pager()).getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/page 2 of 3\./)).toBeInTheDocument();
    expect(lastQuery()).toMatchObject({ page: 2 });
    expect(within(pager()).getByText(/Page 2 of 3/)).toBeInTheDocument();
    expect(within(pager()).getByRole("button", { name: "Previous" })).toBeEnabled();

    await user.click(within(pager()).getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/page 3 of 3\./)).toBeInTheDocument();
    expect(lastQuery()).toMatchObject({ page: 3 });
    // The last page is the last page: Next must not ask for a fourth.
    expect(within(pager()).getByRole("button", { name: "Next" })).toBeDisabled();

    await user.click(within(pager()).getByRole("button", { name: "Previous" }));
    expect(await screen.findByText(/page 2 of 3\./)).toBeInTheDocument();
    expect(lastQuery()).toMatchObject({ page: 2 });
  });

  it("always reports how many there are, even when they all fit on one page", async () => {
    // A filtered queue that fits showed no total at all, so a coordinator
    // could not tell 2 from 2-of-70 without scrolling to look for a pager.
    mockUnassigned([kandyNoSupervisor, colomboCrewTooSmall]);
    render(<UnassignedVisitsPage />);
    await screen.findByText("Grandview Hotel");

    expect(screen.getByText("All 2 unassigned visits are shown.")).toBeInTheDocument();
  });

  it("offers the backlog nobody has looked at as a conflict choice", async () => {
    // 63 of 70 queued visits carry no conflicts at all. Without this the
    // Conflict type filter could only name the seven that need a decision.
    const user = await renderPage();

    await user.click(screen.getByLabelText("Conflict type"));
    await user.click(await screen.findByRole("option", { name: "Not yet checked" }));

    const lastCall = vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ checked: false, page: 1 });
    expect(lastCall).not.toHaveProperty("conflictGroup");
  });

  it("asks the server for an operation state rather than sending a status", async () => {
    const user = await renderPage();

    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: "Checked and refused" }));

    const lastCall = vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ operationState: "EXCEPTION", page: 1 });
    expect(lastCall).not.toHaveProperty("status");
  });

  it("asks the server for unchecked work by its operation state", async () => {
    const user = await renderPage();

    await user.click(screen.getByLabelText("Status"));
    // Not "Unassigned": on the Visit Calendar that word means the scheduler
    // tried and failed, and here it means precisely the opposite — nobody has
    // tried. The same word for opposite facts is how a coordinator came to
    // read three different numbers as one.
    expect(screen.queryByRole("option", { name: "Unassigned" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Not checked yet" }));

    expect(vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0]).toMatchObject({
      operationState: "UNASSIGNED",
    });
  });

  it("still shows only the visit asked for by name", async () => {
    // focusVisitId is not a filter — it names one visit — and it has to keep
    // winning now that the filters, and the lookup itself, are the server's.
    searchParamsRef.current = new URLSearchParams("visit=visit-kandy");
    mockUnassigned([kandyNoSupervisor]);
    render(<UnassignedVisitsPage />);
    await screen.findByText("Grandview Hotel");

    expect(screen.getByText(/Showing the one visit you asked about/)).toBeInTheDocument();
    expect(screen.queryByText("Cinnamon Grand Colombo")).not.toBeInTheDocument();
  });

  it("asks the server for the named visit instead of today's first page", async () => {
    // The whole defect in one assertion. The request used to carry today's
    // date and page 1 and leave the id to a browser-side lookup, so a visit
    // on another date — or past row 25 — was never in the response at all.
    // `visitId` goes to the server on its own; the queue's own filters do
    // not travel with it, because they are exactly what excluded the visit.
    searchParamsRef.current = new URLSearchParams("visit=visit-kandy");
    mockUnassigned([kandyNoSupervisor]);
    render(<UnassignedVisitsPage />);
    await screen.findByText("Grandview Hotel");

    const query = vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0];
    expect(query).toEqual({ visitId: "visit-kandy" });
  });

  it("shows a focused visit dated outside the queue's date filter", async () => {
    // The server found it; the page shows it, date and all, rather than
    // quietly dropping it for not matching the date control beside it.
    searchParamsRef.current = new URLSearchParams("visit=visit-far-off");
    const farOff = buildUnassignedVisit({
      visitId: "visit-far-off",
      visitDate: "2026-11-24",
      customerName: "Heritage Kandalama",
    });
    mockUnassigned([farOff]);
    render(<UnassignedVisitsPage />);

    expect(await screen.findByText("Heritage Kandalama")).toBeInTheDocument();
    expect(screen.getByText(/24 November 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Showing the one visit you asked about/)).toBeInTheDocument();
  });

  it("shows a focused visit that would have fallen beyond the first page", async () => {
    // Same date as the queue, but row 431 of it. There is no page to search:
    // the server was asked about this visit and answered about this visit.
    searchParamsRef.current = new URLSearchParams("visit=visit-page-9");
    const deepInTheQueue = buildUnassignedVisit({
      visitId: "visit-page-9",
      customerName: "Jetwing Lighthouse",
    });
    mockUnassigned([deepInTheQueue], 1);
    render(<UnassignedVisitsPage />);

    expect(await screen.findByText("Jetwing Lighthouse")).toBeInTheDocument();
    // Not a page of a larger list, so no pager and no "showing 1 of 640".
    expect(screen.queryByRole("navigation", { name: /pages/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing 1 of/)).not.toBeInTheDocument();
  });

  it("says the named visit was not found rather than showing an empty queue", async () => {
    searchParamsRef.current = new URLSearchParams("visit=visit-gone");
    mockUnassigned([]);
    render(<UnassignedVisitsPage />);

    expect(
      await screen.findByText("That visit isn't in the unassigned queue")
    ).toBeInTheDocument();
    // Not the generic "everything is staffed" message, which would be a lie
    // about a different question entirely.
    expect(screen.queryByText("Nothing unassigned")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show all unassigned visits" })
    ).toHaveAttribute("href", "/unassigned-visits");
  });

  it("never renders unrelated rows as the answer to a focused visit", async () => {
    // The old failure, reproduced: a response that does not contain the
    // visit that was asked for. Whatever it does contain is not an answer to
    // the question, and must not be displayed as though it were.
    searchParamsRef.current = new URLSearchParams("visit=visit-absent");
    mockUnassigned([kandyNoSupervisor, colomboCrewTooSmall], 640);
    render(<UnassignedVisitsPage />);

    expect(
      await screen.findByText("That visit isn't in the unassigned queue")
    ).toBeInTheDocument();
    expect(screen.queryByText("Grandview Hotel")).not.toBeInTheDocument();
    expect(screen.queryByText("Cinnamon Grand Colombo")).not.toBeInTheDocument();
  });

  it("reads a refused visit id as 'not found', not as an outage", async () => {
    // A focused request sends one parameter. The only thing the API can
    // refuse about it is the id itself, so a malformed link is a bad link —
    // reporting it as a failed load would send a manager chasing the server.
    searchParamsRef.current = new URLSearchParams("visit=not-a-visit-id");
    vi.mocked(fetchUnassignedVisits).mockRejectedValue(
      new ApiError({ code: "VALIDATION_FAILED", message: "visitId must be a UUID" })
    );
    render(<UnassignedVisitsPage />);

    expect(
      await screen.findByText("That visit isn't in the unassigned queue")
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load unassigned visits")).not.toBeInTheDocument();
  });

  it("still reports a real failure as a failure when a visit is focused", async () => {
    searchParamsRef.current = new URLSearchParams("visit=visit-kandy");
    vi.mocked(fetchUnassignedVisits).mockRejectedValue(
      new ApiError({ code: "INTERNAL_ERROR", message: "Upstream is down." })
    );
    render(<UnassignedVisitsPage />);

    expect(await screen.findByText("Couldn't load unassigned visits")).toBeInTheDocument();
    expect(
      screen.queryByText("That visit isn't in the unassigned queue")
    ).not.toBeInTheDocument();
  });

  it("sends the ordinary filters, and no visitId, when no visit is named", async () => {
    // The other half of the contract: nothing about the normal queue moved.
    const user = await renderPage();

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    const query = vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0];
    expect(query).toMatchObject({ branchCode: "KANDY", page: 1, pageSize: 25 });
    expect(query).not.toHaveProperty("visitId");
  });

  /**
   * The backlog is the page's whole purpose, and the date was hiding it.
   *
   * The filter opened on today and could not be cleared, so a queue holding a
   * hundred-odd uncrewed visits across three months — four of them inside a
   * week already published — showed "Nothing unassigned / Every visit
   * currently has a valid crew and vehicle assignment", directly under a
   * heading promising "including work nobody has tried to staff yet".
   */
  it("asks for the whole backlog, with no date, until a manager picks one", async () => {
    await renderPage();

    const query = vi.mocked(fetchUnassignedVisits).mock.calls.at(0)?.[0];
    expect(query).not.toHaveProperty("from");
    expect(query).not.toHaveProperty("to");
  });

  it("narrows to one date when a manager picks one, and lets them clear it again", async () => {
    const user = await renderPage();

    await user.type(screen.getByLabelText("Date"), "2026-09-18");
    expect(vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0]).toMatchObject({
      from: "2026-09-18",
      to: "2026-09-18",
      page: 1,
    });

    await user.click(screen.getByRole("button", { name: /Clear date/ }));
    const cleared = vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0];
    expect(cleared).not.toHaveProperty("from");
    expect(cleared).not.toHaveProperty("to");
  });

  it("names the date it found nothing on rather than clearing the whole system", async () => {
    const user = await renderPage();
    mockUnassigned([]);

    await user.type(screen.getByLabelText("Date"), "2026-09-18");

    expect(await screen.findByText("Nothing unassigned on Friday 18 September 2026")).toBeInTheDocument();
    expect(
      screen.queryByText(/Every visit currently has a valid crew/)
    ).not.toBeInTheDocument();
  });

  it("says a filter is hiding the queue instead of vouching for every visit", async () => {
    const user = await renderPage();
    mockUnassigned([]);

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    expect(await screen.findByText("Nothing matches these filters")).toBeInTheDocument();
    expect(
      screen.queryByText(/Every visit currently has a valid crew/)
    ).not.toBeInTheDocument();
  });

  it("keeps the Kandy PMS shortage notice on a focused visit", async () => {
    searchParamsRef.current = new URLSearchParams("visit=visit-kandy");
    mockUnassigned([kandyNoSupervisor]);
    render(<UnassignedVisitsPage />);
    await screen.findByText("Grandview Hotel");

    expect(screen.getByText("Kandy has no PMS supervisor available")).toBeInTheDocument();
  });

  it("shows an empty state when nothing is unassigned", async () => {
    // No filter is set, so the queue has looked at everything and may say so.
    mockUnassigned([]);
    render(<UnassignedVisitsPage />);

    expect(await screen.findByText("Nothing unassigned")).toBeInTheDocument();
    expect(
      screen.getByText(/Every visit in the system has a crew/)
    ).toBeInTheDocument();
  });

  it("says so when the page holds fewer visits than the API reports", async () => {
    mockUnassigned([kandyNoSupervisor, colomboCrewTooSmall], 640);
    await renderPage();

    expect(
      screen.getByText(/Showing 2 of 640 unassigned visits/)
    ).toBeInTheDocument();
  });

  it("does not use color as the only signal for a conflict group", async () => {
    await renderPage();

    // Each conflict card carries the group's text label and the written
    // sentence alongside its icon, not just a colored badge. The engine's own
    // code is not shouted at the manager.
    const row = screen.getByText("Grandview Hotel").closest("li")!;
    expect(within(row).getByText("Missing PMS supervisor")).toBeInTheDocument();
    expect(
      within(row).getByText("No PMS-grade supervisor is available in Kandy for this visit.")
    ).toBeInTheDocument();
    expect(within(row).queryByText("BRANCH_HAS_NO_PMS_SUPERVISOR")).not.toBeInTheDocument();
  });

  it("never shows a not-yet-checked visit as if it had no problems", async () => {
    // hasBeenChecked: false means nobody has proposed a crew — the queue
    // used to only list refusals, so this state is new. An empty conflict
    // list here must never read as "this visit is fine".
    const untried = buildUnassignedVisit({
      visitId: "visit-untried",
      customerName: "Arpico DC",
      operationState: "UNASSIGNED",
      hasBeenChecked: false,
      conflicts: [],
    });
    mockUnassigned([untried]);
    render(<UnassignedVisitsPage />);
    await screen.findByText("Arpico DC");

    const row = screen.getByText("Arpico DC").closest("li")!;
    expect(within(row).getByText("Not yet checked")).toBeInTheDocument();
    expect(within(row).getByText(/hasn.t been checked/)).toBeInTheDocument();
  });
});
