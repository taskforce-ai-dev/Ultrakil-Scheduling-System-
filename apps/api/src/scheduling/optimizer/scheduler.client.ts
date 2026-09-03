import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppException } from '../../common/errors/app.exception';

/** Mirrors `services/scheduler/app/solver/schemas.py`. */
export interface SolveRequest {
  run_id: string;
  visits: {
    id: string;
    branch_code: string;
    visit_date: string;
    window_start_minute: number;
    window_end_minute: number;
    duration_minutes: number;
    required_crew_size: number;
    required_skill_codes: string[];
    service_site_id: string;
    service_agreement_id: string;
    is_preferred_day: boolean;
    /** Every legal date and time this visit may take. Empty pins it in place. */
    candidate_slots: {
      date: string;
      earliest_start_minute: number;
      latest_start_minute: number;
      is_preferred: boolean;
    }[];
  }[];
  employees: {
    id: string;
    branch_code: string;
    is_pms_grade: boolean;
    is_permanently_stationed: boolean;
    permanent_site_ids: string[];
    skill_codes: string[];
    authorized_vehicle_ids: string[];
    unavailable_dates: string[];
  }[];
  vehicles: {
    id: string;
    branch_code: string | null;
    seat_capacity: number | null;
  }[];
  locks: {
    visit_id: string;
    scope: 'FULL' | 'CREW' | 'VEHICLE' | 'TIME';
    employee_ids: string[];
    vehicle_ids: string[];
    start_minute: number | null;
  }[];
  existing: {
    visit_id: string;
    employee_ids: string[];
    vehicle_ids: string[];
  }[];
  time_limit_seconds: number;
}

export interface SolveResponse {
  run_id: string;
  status: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN';
  assignments: {
    visit_id: string;
    employee_ids: string[];
    vehicles: { vehicle_id: string; driver_employee_id: string }[];
    start_minute: number;
    /** The date the solver settled on, which may differ from the generated one. */
    scheduled_date: string;
  }[];
  unassigned: {
    visit_id: string;
    reason_codes: string[];
    message: string;
  }[];
  solve_seconds: number;
  objective_value: number;
  visits_considered: number;
}

/**
 * Talks to the Python solver.
 *
 * The only thing in the API that knows the scheduler exists over HTTP. It
 * returns a proposal and nothing else — every write, and every re-check against
 * the hard rules, happens back here where the database is.
 */
@Injectable()
export class SchedulerClient {
  private readonly logger = new Logger(SchedulerClient.name);

  constructor(private readonly config: ConfigService) {}

  async solve(request: SolveRequest, timeoutMs: number): Promise<SolveResponse> {
    const baseUrl = this.config.getOrThrow<string>('scheduler.baseUrl');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new AppException(
          'SCHEDULER_UNAVAILABLE',
          `The scheduling service rejected the request (HTTP ${response.status}). ${detail.slice(0, 200)}`,
          HttpStatus.BAD_GATEWAY,
          { status: response.status },
        );
      }

      return (await response.json()) as SolveResponse;
    } catch (caught) {
      if (caught instanceof AppException) throw caught;

      const reason = caught instanceof Error ? caught.message : String(caught);
      this.logger.warn(`Scheduler call failed: ${reason}`);
      throw new AppException(
        'SCHEDULER_UNAVAILABLE',
        `Could not reach the scheduling service at ${baseUrl}. Start it with "pnpm dev:scheduler" and check SCHEDULER_BASE_URL.`,
        HttpStatus.SERVICE_UNAVAILABLE,
        { baseUrl },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
