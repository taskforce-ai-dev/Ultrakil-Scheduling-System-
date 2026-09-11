import { describe, expect, it } from "vitest";

import {
  CONFLICT_CODES,
  type ConflictCode as ServerConflictCode,
} from "../../../../api/src/scheduling/eligibility/conflict-codes";
import {
  CONFLICT_GROUPS as SERVER_CONFLICT_GROUPS,
  CONFLICT_GROUP_CODES,
  conflictGroupOf,
} from "../../../../api/src/scheduling/eligibility/conflict-groups";
import {
  CONFLICT_GROUPS,
  CONFLICT_GROUP_LABEL,
  conflictGroup,
} from "@/lib/conflict-groups";
import type { ConflictCode } from "@/lib/api-client";

/**
 * The two conflict-group catalogues must agree, and this is where that is
 * checked rather than asserted in a comment.
 *
 * The server's catalogue decides which visits a `conflictGroup` filter
 * returns; this one decides which group label the conflict is shown under. If
 * they drift, a manager filters for "Missing skill" and is handed a list whose
 * rows are labelled something else — the queue contradicting itself, which is
 * worse than either answer alone.
 *
 * The imports reach across the workspace on purpose: comparing the frontend
 * copy with a *restatement* of the server's would only prove the restatement
 * was copied correctly on the day it was written.
 */
describe("conflict group catalogues", () => {
  it("offers the same groups, in the same order, on both sides", () => {
    expect(CONFLICT_GROUPS).toEqual([...SERVER_CONFLICT_GROUPS]);
  });

  it("sorts every engine conflict code into the same group on both sides", () => {
    for (const code of CONFLICT_CODES) {
      expect(conflictGroup(code as unknown as ConflictCode)).toBe(
        conflictGroupOf(code),
      );
    }
  });

  it("knows every code the engine publishes", () => {
    // The frontend map is a Record<ConflictCode, ConflictGroup> keyed off the
    // generated contract, so an ungrouped new code fails typecheck — this
    // proves the contract the frontend compiled against is the same catalogue
    // the server filters with.
    const grouped = Object.values(CONFLICT_GROUP_CODES).flat();
    expect([...grouped].sort()).toEqual([...CONFLICT_CODES].sort());
  });

  it("gives every group the server defines a human-readable label", () => {
    for (const group of SERVER_CONFLICT_GROUPS) {
      expect(CONFLICT_GROUP_LABEL[group]).toBeTruthy();
    }
  });

  it("keeps the group a code is filtered by and the group it is labelled with identical", () => {
    for (const group of SERVER_CONFLICT_GROUPS) {
      for (const code of CONFLICT_GROUP_CODES[group] as ServerConflictCode[]) {
        expect(conflictGroup(code as unknown as ConflictCode)).toBe(group);
      }
    }
  });
});
