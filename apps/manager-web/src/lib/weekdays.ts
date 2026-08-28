/**
 * Matches the real `Weekday` / `FrequencyUnit` / `DayRuleKind` enums
 * (`apps/api/prisma/schema.prisma`) exactly — these aren't published as
 * standalone TypeScript types by `@ultrakil/api-contracts` (they only appear
 * inline as string-literal unions on each DTO), so this is the one shared
 * place the portal spells them out.
 */
export type Weekday =
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY"
  | "SUNDAY";

export const WEEKDAYS: Weekday[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

export type FrequencyUnit = "WEEK" | "MONTH";

/** ALLOWED is a hard constraint; PREFERRED is a soft ranking preference only. */
export type DayRuleKind = "ALLOWED" | "PREFERRED";
