import { describe, expect, it } from "vitest";

import {
  cadenceName as serverCadenceName,
  cadenceNoun as serverCadenceNoun,
  describeFrequency as serverDescribeFrequency,
  inWords as serverInWords,
} from "../../../../api/src/scheduling/visit-generation/cadence";
import {
  cadenceName,
  cadenceNoun,
  cadenceSpans,
  describeFrequency,
  inWords,
  type CadenceUnit,
} from "@/lib/cadence";

/**
 * The portal's cadence words and the API's must be the same words.
 *
 * The portal names a cadence a manager has not saved yet; the API names every
 * cadence already on record, and puts that name in `frequencyLabel`. If the
 * two drift, the same contract is a fortnight in the form and a week in the
 * table — which is how a coordinator came to believe the scheduler was
 * dropping visits.
 *
 * The import reaches across the workspace on purpose: comparing this copy with
 * a *restatement* of the server's would only prove the restatement was copied
 * correctly on the day it was written.
 */
const UNITS: CadenceUnit[] = ["WEEK", "MONTH"];
// Past 12 the API's own vocabulary falls back to digits; 0 is not a cadence.
const INTERVALS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const COUNTS = [1, 2, 3, 4, 31];

describe("cadence vocabulary", () => {
  it("names every cadence the same way on both sides", () => {
    for (const unit of UNITS) {
      for (const interval of INTERVALS) {
        expect(cadenceName(unit, interval)).toBe(serverCadenceName(unit, interval));
        expect(cadenceNoun(unit, interval)).toBe(serverCadenceNoun(unit, interval));
      }
    }
  });

  it("describes every frequency the same way on both sides", () => {
    for (const unit of UNITS) {
      for (const interval of INTERVALS) {
        for (const count of COUNTS) {
          expect(describeFrequency(count, unit, interval)).toBe(
            serverDescribeFrequency(count, unit, interval),
          );
        }
      }
    }
  });

  it("spells cycle lengths in words on both sides", () => {
    for (const count of [0, 1, 2, 3, 12, 13]) {
      expect(inWords(count)).toBe(serverInWords(count));
    }
  });

  it("never reads an interval of 2 as if it were 1", () => {
    // The defect itself, pinned: "1x / week" for a fortnightly contract.
    expect(describeFrequency(1, "WEEK", 2)).toBe("Fortnightly");
    expect(describeFrequency(1, "MONTH", 2)).toBe("Two-monthly");
  });

  it("counts several spans without inventing a double plural", () => {
    expect(cadenceSpans("WEEK", 2)).toBe("fortnights");
    expect(cadenceSpans("WEEK", 3)).toBe("three weeks");
    expect(cadenceSpans("MONTH", 3)).toBe("quarters");
  });
});
