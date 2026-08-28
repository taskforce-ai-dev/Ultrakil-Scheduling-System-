import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { WEEKDAYS, type Weekday } from "@/lib/weekdays";

const WEEKDAY_LABELS: Record<Weekday, string> = {
  MONDAY: "Mon",
  TUESDAY: "Tue",
  WEDNESDAY: "Wed",
  THURSDAY: "Thu",
  FRIDAY: "Fri",
  SATURDAY: "Sat",
  SUNDAY: "Sun",
};

interface WeekdayCheckboxGroupProps {
  idPrefix: string;
  legend: string;
  hint?: string;
  selected: Weekday[];
  onChange: (next: Weekday[]) => void;
  /**
   * When set, only these days can be checked — the rest render disabled.
   * Used for the "preferred" group: a preferred day must already be allowed.
   */
  restrictTo?: Weekday[];
  disabledHint?: string;
}

/**
 * Allowed days are a hard scheduling constraint; preferred days are a soft
 * ranking preference. Rendered as two separate groups (never one list with a
 * "preferred" sub-toggle) so a manager cannot mistake one for the other.
 */
export function WeekdayCheckboxGroup({
  idPrefix,
  legend,
  hint,
  selected,
  onChange,
  restrictTo,
  disabledHint,
}: WeekdayCheckboxGroupProps) {
  function toggle(day: Weekday, checked: boolean) {
    onChange(checked ? [...selected, day] : selected.filter((d) => d !== day));
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="flex flex-wrap gap-3">
        {WEEKDAYS.map((day) => {
          const id = `${idPrefix}-${day}`;
          const isDisabled = restrictTo ? !restrictTo.includes(day) : false;

          return (
            <div key={day} className="flex items-center gap-1.5" title={isDisabled ? disabledHint : undefined}>
              <Checkbox
                id={id}
                checked={selected.includes(day)}
                disabled={isDisabled}
                onCheckedChange={(checked) => toggle(day, checked === true)}
              />
              <Label htmlFor={id} className="text-sm font-normal">
                {WEEKDAY_LABELS[day]}
              </Label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
