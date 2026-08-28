import { describe, expect, it } from "vitest";

import { computeSchedulePreview, SchedulePreviewError } from "@/lib/schedule-preview";
import type { ServiceSite } from "@/lib/mock-data/types";

const site: ServiceSite = {
  id: "site-1",
  customerId: "cust-1",
  name: "Main Kitchen",
  addressLine: null,
  city: null,
  branchCode: "COLOMBO",
  isActive: true,
  operatingHours: [
    { weekday: "MONDAY", opensAtMinute: 6 * 60, closesAtMinute: 22 * 60 },
    { weekday: "WEDNESDAY", opensAtMinute: 8 * 60, closesAtMinute: 18 * 60 },
    // TUESDAY deliberately closed, to prove a closed day never produces a visit.
  ],
};

describe("computeSchedulePreview", () => {
  it("rejects with no allowed day selected", async () => {
    await expect(
      computeSchedulePreview({
        frequencyCount: 1,
        frequencyUnit: "WEEK",
        dayRules: [],
        startDate: "2026-01-05",
        endDate: null,
        site,
        serviceWindowStartMinute: null,
        serviceWindowEndMinute: null,
      })
    ).rejects.toBeInstanceOf(SchedulePreviewError);
  });

  it("rejects with no start date", async () => {
    await expect(
      computeSchedulePreview({
        frequencyCount: 1,
        frequencyUnit: "WEEK",
        dayRules: [{ weekday: "MONDAY", kind: "ALLOWED" }],
        startDate: "",
        endDate: null,
        site,
        serviceWindowStartMinute: null,
        serviceWindowEndMinute: null,
      })
    ).rejects.toBeInstanceOf(SchedulePreviewError);
  });

  it("uses each allowed day's own site hours (different weekday hours)", async () => {
    // 2026-01-05 is a Monday.
    const visits = await computeSchedulePreview({
      frequencyCount: 2,
      frequencyUnit: "WEEK",
      dayRules: [
        { weekday: "MONDAY", kind: "ALLOWED" },
        { weekday: "WEDNESDAY", kind: "ALLOWED" },
      ],
      startDate: "2026-01-05",
      endDate: "2026-01-11",
      site,
      serviceWindowStartMinute: null,
      serviceWindowEndMinute: null,
    });

    const monday = visits.find((visit) => visit.weekday === "MONDAY");
    const wednesday = visits.find((visit) => visit.weekday === "WEDNESDAY");
    expect(monday).toMatchObject({ windowStartMinute: 6 * 60, windowEndMinute: 22 * 60 });
    expect(wednesday).toMatchObject({ windowStartMinute: 8 * 60, windowEndMinute: 18 * 60 });
  });

  it("never schedules a visit on a day the site has no operating hours for", async () => {
    const visits = await computeSchedulePreview({
      frequencyCount: 5,
      frequencyUnit: "WEEK",
      dayRules: [{ weekday: "TUESDAY", kind: "ALLOWED" }],
      startDate: "2026-01-05",
      endDate: "2026-01-18",
      site,
      serviceWindowStartMinute: null,
      serviceWindowEndMinute: null,
    });
    expect(visits).toHaveLength(0);
  });

  it("caps visits per week at frequencyCount and ranks preferred days first", async () => {
    const richSite: ServiceSite = {
      ...site,
      operatingHours: [
        { weekday: "MONDAY", opensAtMinute: 9 * 60, closesAtMinute: 17 * 60 },
        { weekday: "WEDNESDAY", opensAtMinute: 9 * 60, closesAtMinute: 17 * 60 },
      ],
    };

    const visits = await computeSchedulePreview({
      frequencyCount: 1,
      frequencyUnit: "WEEK",
      dayRules: [
        { weekday: "MONDAY", kind: "ALLOWED" },
        { weekday: "WEDNESDAY", kind: "ALLOWED" },
        { weekday: "WEDNESDAY", kind: "PREFERRED" },
      ],
      startDate: "2026-01-05",
      endDate: "2026-01-11",
      site: richSite,
      serviceWindowStartMinute: null,
      serviceWindowEndMinute: null,
    });

    expect(visits).toHaveLength(1);
    expect(visits[0].weekday).toBe("WEDNESDAY");
    expect(visits[0].isPreferredDay).toBe(true);
  });

  it("an override window replaces the site's hours", async () => {
    const visits = await computeSchedulePreview({
      frequencyCount: 1,
      frequencyUnit: "WEEK",
      dayRules: [{ weekday: "MONDAY", kind: "ALLOWED" }],
      startDate: "2026-01-05",
      endDate: "2026-01-05",
      site,
      serviceWindowStartMinute: 10 * 60,
      serviceWindowEndMinute: 12 * 60,
    });

    expect(visits).toEqual([
      expect.objectContaining({ windowStartMinute: 10 * 60, windowEndMinute: 12 * 60 }),
    ]);
  });
});
