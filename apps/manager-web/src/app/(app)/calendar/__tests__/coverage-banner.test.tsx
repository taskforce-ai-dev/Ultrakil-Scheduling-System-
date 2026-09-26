import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CoverageResponse } from '@/lib/api-client';
import { CoverageBanner } from '../coverage-banner';

const day: CoverageResponse['boundaryDay'] = {
  date: '2026-10-25', state: 'COVERED_PUBLISHED', visitsDue: 2,
  visitsPublished: 2, visitsPrepared: 0, shortfalls: [],
};
const covered: CoverageResponse = {
  windowStart: '2026-10-25', windowEnd: '2026-10-25', branchCode: null,
  coveredThrough: '2026-10-25', fullyPublished: true,
  boundaryDay: day, days: [day],
};

describe('CoverageBanner', () => {
  it('states the verified published boundary, not just visible calendar rows', () => {
    render(<CoverageBanner coverage={covered} />);
    expect(screen.getByRole('status')).toHaveTextContent('Published coverage verified through');
    expect(screen.getByRole('status')).toHaveTextContent('25 October 2026');
  });

  it('warns that drafts are prepared but not published', () => {
    render(<CoverageBanner coverage={{
      ...covered, fullyPublished: false, coveredThrough: null,
      boundaryDay: { ...day, state: 'PREPARED_AWAITING_MANAGER', visitsPublished: 0, visitsPrepared: 2 },
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Prepared, awaiting manager review');
    expect(screen.getByRole('alert')).toHaveTextContent('0 of 2 published');
    expect(screen.getByRole('link', { name: /Open Assign Crew/ })).toHaveAttribute('href', '/schedule-history');
  });

  it('shows shortfall reasons without employee or customer names', () => {
    render(<CoverageBanner coverage={{
      ...covered, fullyPublished: false, coveredThrough: null,
      boundaryDay: { ...day, state: 'SHORTFALL', visitsPublished: 1,
        shortfalls: [{ code: 'NO_PMS_SUPERVISOR_AVAILABLE', message: 'No qualified PMS supervisor is available.' }] },
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('No qualified PMS supervisor is available.');
    expect(screen.getByRole('link', { name: /Open Unassigned Visits/ })).toHaveAttribute('href', '/unassigned-visits');
  });

  it('refuses an all-clear when a day has not been verified', () => {
    render(<CoverageBanner coverage={{
      ...covered, fullyPublished: false, coveredThrough: null,
      boundaryDay: { ...day, state: 'UNCHECKED', visitsDue: 0, visitsPublished: 0 },
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Coverage has not been verified');
    expect(screen.queryByText(/Published coverage verified through/)).not.toBeInTheDocument();
  });

  it('points at the first gap even when the far boundary is published', () => {
    const gap = { ...day, date: '2026-10-01', state: 'SHORTFALL' as const,
      visitsPublished: 0, shortfalls: [{ code: 'NO_CREW_AVAILABLE', message: 'No eligible crew is available.' }] };
    render(<CoverageBanner coverage={{
      ...covered, windowStart: '2026-10-01', windowEnd: '2026-10-02',
      fullyPublished: false, coveredThrough: '2026-09-30',
      days: [gap, { ...day, date: '2026-10-02' }], boundaryDay: { ...day, date: '2026-10-02' },
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('1 October 2026');
    expect(screen.getByRole('alert')).toHaveTextContent('No eligible crew is available.');
    expect(screen.queryByRole('status', { name: 'Published coverage' })).not.toBeInTheDocument();
  });

  it('withholds green if a contradictory payload claims fullyPublished despite an unchecked day', () => {
    render(<CoverageBanner coverage={{
      ...covered,
      days: [{ ...day, state: 'UNCHECKED' }],
      boundaryDay: { ...day, state: 'UNCHECKED' },
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Coverage has not been verified');
    expect(screen.queryByRole('status', { name: 'Published coverage' })).not.toBeInTheDocument();
  });

  it('accepts a verified no-due day without inventing dispatched work', () => {
    render(<CoverageBanner coverage={{
      ...covered,
      boundaryDay: { ...day, state: 'NOTHING_DUE', visitsDue: 0, visitsPublished: 0 },
      days: [{ ...day, state: 'NOTHING_DUE', visitsDue: 0, visitsPublished: 0 }],
    }} />);
    expect(screen.getByRole('status', { name: 'Published coverage' })).toHaveTextContent('25 October 2026');
  });

  it('names an invalidated day as stale rather than verified', () => {
    render(<CoverageBanner coverage={{
      ...covered, fullyPublished: false, coveredThrough: null,
      boundaryDay: { ...day, state: 'STALE', shortfalls: [{ code: 'STALE_COVERAGE', message: 'This day changed after verification; recheck staffing and publication.' }] },
      days: [{ ...day, state: 'STALE', shortfalls: [{ code: 'STALE_COVERAGE', message: 'This day changed after verification; recheck staffing and publication.' }] }],
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Coverage needs rechecking');
    expect(screen.queryByRole('status', { name: 'Published coverage' })).not.toBeInTheDocument();
  });

  it('refuses a green banner for a truncated 30-day payload', () => {
    render(<CoverageBanner coverage={{
      ...covered, windowStart: '2026-09-26',
    }} />);
    expect(screen.queryByRole('status', { name: 'Published coverage' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Coverage status is incomplete');
  });
});
