import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, fetchVisit: vi.fn(), lockVisit: vi.fn(), unlockVisit: vi.fn() };
});

import { VisitDetailDrawer } from "../visit-detail-drawer";
import { fetchVisit } from "@/lib/api-client";
import { buildVisitDetail } from "@/test/fixtures";

function show(detail = buildVisitDetail()) {
  vi.mocked(fetchVisit).mockResolvedValue(detail);
  render(
    <VisitDetailDrawer visitId="visit-1" onOpenChange={() => {}} onChanged={() => {}} />
  );
}

beforeEach(() => {
  vi.mocked(fetchVisit).mockReset();
});

describe("VisitDetailDrawer history", () => {
  /**
   * The Edit crew drawer demands a reason for every manual override, then the
   * box reset to its placeholder on save and History listed only "Generated"
   * and "Last updated". A required reason nobody can read back is a form
   * field, not a record.
   */
  it("shows a hand edit and the reason the manager gave for it", async () => {
    show(
      buildVisitDetail({
        crewChanges: [
          {
            changedAt: "2026-09-15T16:10:37.000Z",
            action: "CREW_REPLACED",
            actorLabel: "R Silva <r.silva@ultrakil.test>",
            reason: "Client asked for the senior supervisor.",
            crewSize: 2,
          },
        ],
      })
    );

    const history = (await screen.findByText("History")).closest("section")!;
    expect(within(history).getByText(/Crew changed by hand/)).toBeInTheDocument();
    expect(
      within(history).getByText("Client asked for the senior supervisor.")
    ).toBeInTheDocument();
    expect(within(history).getByText(/R Silva/)).toBeInTheDocument();
  });

  it("says a crew was taken off without inventing a reason nobody gave", async () => {
    show(
      buildVisitDetail({
        crewChanges: [
          {
            changedAt: "2026-09-15T16:10:37.000Z",
            action: "CREW_REMOVED",
            actorLabel: "R Silva <r.silva@ultrakil.test>",
            reason: null,
            crewSize: 0,
          },
        ],
      })
    );

    const history = (await screen.findByText("History")).closest("section")!;
    expect(within(history).getByText(/Crew taken off by hand/)).toBeInTheDocument();
    expect(within(history).queryByText(/No reason given/)).toBeInTheDocument();
  });

  it("stays quiet about hand edits on a visit only the scheduler has touched", async () => {
    show(buildVisitDetail({ crewChanges: [] }));

    const history = (await screen.findByText("History")).closest("section")!;
    expect(within(history).queryByText(/by hand/)).not.toBeInTheDocument();
    expect(within(history).getByText("Generated")).toBeInTheDocument();
  });
});
