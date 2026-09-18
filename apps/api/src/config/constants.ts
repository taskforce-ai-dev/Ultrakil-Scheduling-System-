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
 * Most crew-minutes one branch's day may carry, unless the environment says
 * otherwise. This is the figure `load-guard.ts`, the commit-time recheck in
 * `visit-generation.service.ts`, and the optimizer's `DailyLoadLedger`
 * actually enforce.
 *
 * A visit's own cost is its duration times its crew size — the minutes a
 * crew actually spends on it, counted once per crew member rather than once
 * per visit — so a fifteen-minute single-person check and a four-hour
 * four-person job are no longer the same "one visit" a raw count made them.
 *
 * The default, 720 (twelve hours of crew-minutes), is a judgment call, not a
 * measurement: generation has no view of how many crews or vehicles a branch
 * actually has on a given day — that is the optimizer's and the eligibility
 * engine's question, asked against real employees, skills, PMS coverage and
 * vehicles, deliberately after generation has only placed a *date*. Twelve
 * crew-hours is chosen to read the old cap's implied assumption — twelve
 * visits of about an hour, one crew member each — as a starting point a
 * branch can retune with real throughput data, not as a fact about UltraKIL's
 * actual capacity.
 */
export const DEFAULT_DAILY_CAPACITY_MINUTES = 720;
