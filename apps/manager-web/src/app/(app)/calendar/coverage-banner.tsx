import Link from 'next/link';
import { CircleCheck, TriangleAlert } from 'lucide-react';

import type { CoverageResponse } from '@/lib/api-client';
import { addDays, formatLongDate } from '@/lib/calendar';

const STATE_COPY = {
  UNCHECKED: 'Coverage has not been verified',
  IN_PROGRESS: 'Automatic staffing is checking this day',
  NOTHING_DUE: 'No visits due; day verified',
  FAILED: 'Automatic staffing needs attention',
  SHORTFALL: 'Staffing shortfall',
  STALE: 'Coverage needs rechecking',
  PREPARED_AWAITING_MANAGER: 'Prepared, awaiting manager review',
  COVERED_PUBLISHED: 'Published coverage verified',
} as const;

/** The Calendar's tiles include proposals; this banner speaks only for verified dispatch. */
export function CoverageBanner({ coverage }: { coverage: CoverageResponse }) {
  const completeWindow = coverage.days.length > 0 &&
    coverage.days[0].date === coverage.windowStart &&
    coverage.days.every((day, index) => day.date === addDays(coverage.windowStart, index)) &&
    coverage.days[coverage.days.length - 1].date === coverage.windowEnd &&
    coverage.boundaryDay.date === coverage.windowEnd;
  if (!completeWindow) {
    return (
      <section role="alert" aria-label="Coverage needs attention" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
        Coverage status is incomplete for this window. Do not treat Calendar drafts as published dispatch; refresh or ask a manager to check Assign Crew.
      </section>
    );
  }
  const verified = coverage.fullyPublished &&
    coverage.coveredThrough === coverage.windowEnd &&
    (coverage.boundaryDay.state === 'COVERED_PUBLISHED' || coverage.boundaryDay.state === 'NOTHING_DUE') &&
    coverage.days.length > 0 &&
    coverage.days.every((day) => day.state === 'COVERED_PUBLISHED' || day.state === 'NOTHING_DUE');
  if (verified) {
    return (
      <section role="status" aria-label="Published coverage" className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100">
        <div className="flex items-start gap-3">
          <CircleCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">Published coverage verified through {formatLongDate(coverage.windowEnd)}</p>
            <p className="text-sm">Every due day in this window has completed verification and published dispatch. Drafts do not count.</p>
          </div>
        </div>
      </section>
    );
  }

  const attention = coverage.days.find((day) => day.state !== 'COVERED_PUBLISHED' && day.state !== 'NOTHING_DUE') ?? coverage.boundaryDay;
  const nextAction = attention.state === 'PREPARED_AWAITING_MANAGER' || attention.state === 'STALE'
    ? { href: '/schedule-history', label: 'Open Assign Crew and review publication warnings' }
    : { href: '/unassigned-visits', label: 'Open Unassigned Visits' };
  return (
    <section role="alert" aria-label="Coverage needs attention" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold">{STATE_COPY[attention.state]} — {formatLongDate(attention.date)}</p>
          <p className="text-sm">
            {attention.visitsPublished} of {attention.visitsDue} published; {attention.visitsPrepared} prepared but not published.
            {' '} {coverage.coveredThrough
              ? `Contiguous published coverage is verified through ${formatLongDate(coverage.coveredThrough)}.`
              : 'No contiguous published coverage is verified for this window.'}
          </p>
          {attention.shortfalls.length > 0 && (
            <ul className="list-inside list-disc text-sm">
              {attention.shortfalls.map((shortfall) => (
                <li key={shortfall.code}>{shortfall.message}</li>
              ))}
            </ul>
          )}
          <Link className="inline-block text-sm font-semibold underline underline-offset-2" href={nextAction.href}>
            {nextAction.label}
          </Link>
        </div>
      </div>
    </section>
  );
}
