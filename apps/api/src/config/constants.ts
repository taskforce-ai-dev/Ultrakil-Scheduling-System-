/**
 * Defaults the environment schema needs before anything else is wired.
 *
 * These live here rather than beside the code that uses them because
 * `env.validation.ts` is the first thing the process loads: reaching into a
 * domain module for a default drags that module — and everything it imports —
 * into configuration parsing, and makes the dependency point the wrong way.
 */

/**
 * Most visits one branch's day may carry, unless the environment says
 * otherwise.
 *
 * Kept only as the reference number `GET /branches` shows a manager for
 * context — a rough "about this many visits" — never as the figure
 * generation, the load guard or the optimizer actually plan against. It was
 * introduced as "the busiest day in the workbook's own July plan ... never
 * more than twelve", which the Technical Director's own check of the real
 * source workbook against this branch's parser contradicted: the busiest
 * date there carries fifteen jobs, and a raw count could not tell that day
 * apart from an actually overloaded one. {@link DEFAULT_DAILY_CAPACITY_MINUTES}
 * is what capacity is now measured and enforced in.
 */
export const DEFAULT_DAILY_VISIT_CAP = 12;

/**
 * Most crew-minutes one branch's day may carry when this database has no
 * workforce imported for that branch at all — see
 * `branch-day-capacity.ts`'s `NO_WORKFORCE_RECORDED` fallback.
 *
 * This used to be the figure enforced everywhere, a company-wide constant
 * regardless of how many people or vehicles a branch actually had. The
 * Technical Director's review rejected that directly: it could make a valid
 * job "impossible everywhere... even when the branch has enough people."
 * `load-guard.ts`, the commit-time recheck in `visit-generation.service.ts`,
 * and the optimizer's `DailyLoadLedger` now enforce a figure computed per
 * branch per day from real employee headcount, PMS-grade supervision and
 * vehicle/driver availability. This constant survives only as the fallback
 * for a branch this database has no workforce data for at all — a data gap,
 * not a fact about that branch's real capacity — so generation does not
 * silently read "never imported" as "zero people."
 */
export const DEFAULT_DAILY_CAPACITY_MINUTES = 720;

/**
 * Minutes in one employee's standard working day, unless the environment
 * says otherwise — what `branch-day-capacity.ts` multiplies a branch-day's
 * real available headcount by. Eight hours, a standard business day: the
 * schema records no per-employee shift length, so this is the same kind of
 * starting assumption {@link DEFAULT_DAILY_CAPACITY_MINUTES} used to be, a
 * branch can retune with real throughput data, not a fact about UltraKIL's
 * actual shift lengths.
 */
export const DEFAULT_EMPLOYEE_WORKDAY_MINUTES = 480;

/**
 * Minimum transfer time between jobs at different service sites.
 *
 * UltraKIL does not yet hold trustworthy coordinates for every site, so a
 * deterministic company-wide allowance is safer than pretending to know an
 * exact route time. Jobs at the same site need no transfer allowance.
 */
export const DEFAULT_DIFFERENT_SITE_TRAVEL_BUFFER_MINUTES = 60;
