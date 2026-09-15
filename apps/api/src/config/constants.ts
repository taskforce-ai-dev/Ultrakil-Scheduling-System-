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
 * The busiest day in the workbook's own July plan: 159 visits over 28 days,
 * never more than twelve on one of them. It is UltraKIL's demonstrated
 * capacity rather than a number invented here.
 */
export const DEFAULT_DAILY_VISIT_CAP = 12;
