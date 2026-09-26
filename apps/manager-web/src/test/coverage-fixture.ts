import type { CoverageResponse } from '@/lib/api-client';
import { addDays, todayColomboIso } from '@/lib/calendar';

/** UI-only data; a verified no-due day must still come from the API in production. */
export function buildCoverageResponse(overrides: Partial<CoverageResponse> = {}): CoverageResponse {
  const from = todayColomboIso();
  const to = addDays(from, 29);
  const day: CoverageResponse['boundaryDay'] = {
    date: to, state: 'UNCHECKED', visitsDue: 0,
    visitsPublished: 0, visitsPrepared: 0, shortfalls: [],
  };
  return {
    windowStart: from, windowEnd: to, branchCode: null,
    coveredThrough: null, fullyPublished: false, boundaryDay: day,
    days: Array.from({ length: 30 }, (_, index) => ({ ...day, date: addDays(from, index) })),
    ...overrides,
  };
}
