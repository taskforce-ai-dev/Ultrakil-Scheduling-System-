import { CONFLICT_CODES } from './conflict-codes';
import {
  CONFLICT_GROUPS,
  CONFLICT_GROUP_CODES,
  NAMED_CONFLICT_GROUP_CODES,
  conflictGroupOf,
  conflictGroupOfStored,
} from './conflict-groups';

describe('conflict group catalogue', () => {
  it('places every engine conflict code in exactly one group', () => {
    const placed = Object.values(CONFLICT_GROUP_CODES).flat();

    expect([...placed].sort()).toEqual([...CONFLICT_CODES].sort());
    expect(new Set(placed).size).toBe(CONFLICT_CODES.length);
  });

  it('derives the group-to-codes catalogue from the code-to-group one', () => {
    for (const group of CONFLICT_GROUPS) {
      for (const code of CONFLICT_GROUP_CODES[group]) {
        expect(conflictGroupOf(code)).toBe(group);
      }
    }
  });

  it('groups the codes the Unassigned queue filter is offered for', () => {
    expect(CONFLICT_GROUP_CODES.MISSING_SKILL).toEqual(['SKILL_NOT_HELD']);
    expect([...CONFLICT_GROUP_CODES.MISSING_PMS].sort()).toEqual([
      'BRANCH_HAS_NO_PMS_SUPERVISOR',
      'NO_PMS_SUPERVISOR_AVAILABLE',
    ]);
  });

  it('files a stored code it has never seen under OTHER', () => {
    // Reason rows hold plain strings, so a code from an older release — or a
    // producer this catalogue has not caught up with — is possible. It has to
    // land somewhere a manager can still filter for.
    expect(conflictGroupOfStored('SOME_RETIRED_CODE')).toBe('OTHER');
    expect(NAMED_CONFLICT_GROUP_CODES).not.toContain('SOME_RETIRED_CODE');
  });

  it('keeps OTHER as the complement of the named groups', () => {
    const named = new Set(NAMED_CONFLICT_GROUP_CODES);

    for (const code of CONFLICT_GROUP_CODES.OTHER) {
      expect(named.has(code)).toBe(false);
    }
    expect(named.size + CONFLICT_GROUP_CODES.OTHER.length).toBe(
      CONFLICT_CODES.length,
    );
  });

  it('offers the eleven named groups plus Other, in a stable order', () => {
    expect(CONFLICT_GROUPS).toEqual([
      'MISSING_PMS',
      'INSUFFICIENT_CREW',
      'MISSING_SKILL',
      'NO_AUTHORIZED_DRIVER',
      'UNAVAILABLE_VEHICLE',
      'BRANCH_RESTRICTION',
      'PERMANENT_STAFF_RESTRICTION',
      'SERVICE_WINDOW_CONFLICT',
      'EMPLOYEE_OVERLAP',
      'VEHICLE_OVERLAP',
      'CREW_CANNOT_TRAVEL',
      'OTHER',
    ]);
  });
});
