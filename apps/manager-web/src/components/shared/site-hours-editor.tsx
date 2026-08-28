import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { WEEKDAYS, type Weekday } from "@/lib/weekdays";

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

export interface SiteOperatingHours {
  weekday: Weekday;
  opensAtMinute: number;
  closesAtMinute: number;
}

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
 * One or more opening windows per weekday, matching `SiteOperatingHours`
 * (`apps/api/prisma/schema.prisma`): a weekday with no window is closed —
 * there's no separate "closed" flag — and several windows on one weekday are
 * how a site that shuts over lunch is expressed. The backend rejects
 * overlapping windows on the same weekday; that check is not duplicated here.
 */
export function SiteHoursEditor({ idPrefix, value, onChange }: SiteHoursEditorProps) {
  function windowsFor(day: Weekday) {
    return value
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.weekday === day);
  }

  function addWindow(day: Weekday) {
    onChange([
      ...value,
      { weekday: day, opensAtMinute: DEFAULT_OPEN_MINUTE, closesAtMinute: DEFAULT_CLOSE_MINUTE },
    ]);
  }

  function removeWindow(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function updateWindow(index: number, field: "opensAtMinute" | "closesAtMinute", timeValue: string) {
    const minutes = timeInputToMinutes(timeValue);
    if (minutes === null) return;
    onChange(value.map((entry, i) => (i === index ? { ...entry, [field]: minutes } : entry)));
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Opening hours</p>
      <p className="text-xs text-muted-foreground">
        A day with no window is closed. Add more than one window (e.g. a lunch break) for the same day.
      </p>
      <div className="space-y-1.5">
        {WEEKDAYS.map((day) => {
          const windows = windowsFor(day);

          return (
            <div key={day} className="space-y-1.5 rounded-lg border p-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{WEEKDAY_LABELS[day]}</span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={`Add a window on ${WEEKDAY_LABELS[day]}`} onClick={() => addWindow(day)}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>

              {windows.length === 0 ? (
                <span className="text-sm text-muted-foreground">Closed</span>
              ) : (
                windows.map(({ entry, index }, windowNumber) => (
                  <div key={index} className="flex items-center gap-2">
                    <Label htmlFor={`${idPrefix}-${day}-${windowNumber}-opens`} className="sr-only">
                      {WEEKDAY_LABELS[day]} window {windowNumber + 1} opens at
                    </Label>
                    <input
                      id={`${idPrefix}-${day}-${windowNumber}-opens`}
                      type="time"
                      value={minutesToTimeInput(entry.opensAtMinute)}
                      onChange={(event) => updateWindow(index, "opensAtMinute", event.target.value)}
                      className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                    <span className="text-sm text-muted-foreground">to</span>
                    <Label htmlFor={`${idPrefix}-${day}-${windowNumber}-closes`} className="sr-only">
                      {WEEKDAY_LABELS[day]} window {windowNumber + 1} closes at
                    </Label>
                    <input
                      id={`${idPrefix}-${day}-${windowNumber}-closes`}
                      type="time"
                      value={minutesToTimeInput(entry.closesAtMinute)}
                      onChange={(event) => updateWindow(index, "closesAtMinute", event.target.value)}
                      className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove this window on ${WEEKDAY_LABELS[day]}`}
                      onClick={() => removeWindow(index)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
