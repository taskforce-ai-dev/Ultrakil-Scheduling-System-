import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { WEEKDAYS, type SiteOperatingHours, type Weekday } from "@/lib/mock-data/types";

const WEEKDAY_LABELS: Record<Weekday, string> = {
  MONDAY: "Monday",
  TUESDAY: "Tuesday",
  WEDNESDAY: "Wednesday",
  THURSDAY: "Thursday",
  FRIDAY: "Friday",
  SATURDAY: "Saturday",
  SUNDAY: "Sunday",
};

const DEFAULT_OPEN_MINUTE = 9 * 60;
const DEFAULT_CLOSE_MINUTE = 17 * 60;

export function minutesToTimeInput(minutes: number): string {
  const hours = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const mins = (minutes % 60).toString().padStart(2, "0");
  return `${hours}:${mins}`;
}

export function timeInputToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

interface SiteHoursEditorProps {
  idPrefix: string;
  value: SiteOperatingHours[];
  onChange: (next: SiteOperatingHours[]) => void;
}

/**
 * One row per weekday, matching `SiteOperatingHours` (`apps/api/prisma/schema.prisma`):
 * a weekday with no row is closed, and there is only one window per weekday —
 * the schema has no support for a second window on the same day.
 */
export function SiteHoursEditor({ idPrefix, value, onChange }: SiteHoursEditorProps) {
  function entryFor(day: Weekday) {
    return value.find((entry) => entry.weekday === day);
  }

  function setOpen(day: Weekday, isOpen: boolean) {
    if (isOpen) {
      onChange([
        ...value,
        { weekday: day, opensAtMinute: DEFAULT_OPEN_MINUTE, closesAtMinute: DEFAULT_CLOSE_MINUTE },
      ]);
    } else {
      onChange(value.filter((entry) => entry.weekday !== day));
    }
  }

  function updateTime(day: Weekday, field: "opensAtMinute" | "closesAtMinute", timeValue: string) {
    const minutes = timeInputToMinutes(timeValue);
    if (minutes === null) return;
    onChange(
      value.map((entry) => (entry.weekday === day ? { ...entry, [field]: minutes } : entry))
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Opening hours</p>
      <p className="text-xs text-muted-foreground">
        Hours vary by day. Leave a day unchecked to mark the site closed that day.
      </p>
      <div className="space-y-1.5">
        {WEEKDAYS.map((day) => {
          const entry = entryFor(day);
          const isOpen = entry !== undefined;
          const checkboxId = `${idPrefix}-${day}-open`;

          return (
            <div key={day} className="flex flex-wrap items-center gap-3 rounded-lg border p-2">
              <div className="flex w-32 shrink-0 items-center gap-1.5">
                <Checkbox
                  id={checkboxId}
                  checked={isOpen}
                  onCheckedChange={(checked) => setOpen(day, checked === true)}
                />
                <Label htmlFor={checkboxId} className="text-sm font-normal">
                  {WEEKDAY_LABELS[day]}
                </Label>
              </div>

              {isOpen ? (
                <div className="flex items-center gap-2">
                  <Label htmlFor={`${idPrefix}-${day}-opens`} className="sr-only">
                    {WEEKDAY_LABELS[day]} opens at
                  </Label>
                  <input
                    id={`${idPrefix}-${day}-opens`}
                    type="time"
                    value={minutesToTimeInput(entry.opensAtMinute)}
                    onChange={(event) => updateTime(day, "opensAtMinute", event.target.value)}
                    className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                  <span className="text-sm text-muted-foreground">to</span>
                  <Label htmlFor={`${idPrefix}-${day}-closes`} className="sr-only">
                    {WEEKDAY_LABELS[day]} closes at
                  </Label>
                  <input
                    id={`${idPrefix}-${day}-closes`}
                    type="time"
                    value={minutesToTimeInput(entry.closesAtMinute)}
                    onChange={(event) => updateTime(day, "closesAtMinute", event.target.value)}
                    className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">Closed</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
