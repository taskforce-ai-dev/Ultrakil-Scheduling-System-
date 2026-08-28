"use client";

import * as React from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { AlertTriangle, CalendarClock, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AppDrawer } from "@/components/shared/app-drawer";
import { FormField } from "@/components/shared/form-field";
import { EmptyState } from "@/components/shared/empty-state";
import { WeekdayCheckboxGroup } from "@/components/shared/weekday-checkbox-group";
import { timeInputToMinutes } from "@/components/shared/site-hours-editor";
import { Badge } from "@/components/ui/badge";
import { mockCustomers, mockJobTypes, mockServiceAgreements } from "@/lib/mock-data";
import { WEEKDAYS, type ServiceAgreement, type ServiceSite, type Weekday } from "@/lib/mock-data/types";
import {
  computeSchedulePreview,
  SchedulePreviewError,
  type SchedulePreviewVisit,
} from "@/lib/schedule-preview";
import { notify } from "@/lib/notify";

interface ServiceAgreementFormValues {
  customerId: string;
  serviceSiteId: string;
  jobTypeId: string;
  frequencyCount: number;
  frequencyUnit: "WEEK" | "MONTH";
  crewSize: number;
  durationMinutes: number;
  allowedWeekdays: Weekday[];
  preferredWeekdays: Weekday[];
  overrideWindow: boolean;
  windowStart: string;
  windowEnd: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  notes: string;
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${mins.toString().padStart(2, "0")} ${period}`;
}

const WEEKDAY_SHORT: Record<Weekday, string> = {
  MONDAY: "Mon",
  TUESDAY: "Tue",
  WEDNESDAY: "Wed",
  THURSDAY: "Thu",
  FRIDAY: "Fri",
  SATURDAY: "Sat",
  SUNDAY: "Sun",
};

const defaultValues: ServiceAgreementFormValues = {
  customerId: mockCustomers[0]?.id ?? "",
  serviceSiteId: mockCustomers[0]?.sites[0]?.id ?? "",
  jobTypeId: mockJobTypes[0]?.id ?? "",
  frequencyCount: 1,
  frequencyUnit: "WEEK",
  crewSize: mockJobTypes[0]?.defaultCrewSize ?? 2,
  durationMinutes: mockJobTypes[0]?.defaultDurationMinutes ?? 60,
  allowedWeekdays: [],
  preferredWeekdays: [],
  overrideWindow: false,
  windowStart: "09:00",
  windowEnd: "17:00",
  startDate: "",
  endDate: "",
  isActive: true,
  notes: "",
};

/**
 * No business-rule validation lives here on purpose — hard rules (service-area
 * matching, PMS supervisor coverage, etc.) are enforced by Chanya's API, not
 * duplicated in the UI. The one exception is "a preferred day must already be
 * allowed", which is a form-input constraint, not a scheduling rule, and the
 * "visits per period exceeds the number of allowed days" check, which is
 * arithmetic rather than a business decision.
 */
export default function ServiceAgreementsPage() {
  const [agreements, setAgreements] = React.useState<ServiceAgreement[]>(mockServiceAgreements);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<SchedulePreviewVisit[] | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = React.useState(false);

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<ServiceAgreementFormValues>({ defaultValues });

  const customerId = useWatch({ control, name: "customerId" });
  const serviceSiteId = useWatch({ control, name: "serviceSiteId" });
  const jobTypeId = useWatch({ control, name: "jobTypeId" });
  const frequencyCount = useWatch({ control, name: "frequencyCount" });
  const frequencyUnit = useWatch({ control, name: "frequencyUnit" });
  const allowedWeekdays = useWatch({ control, name: "allowedWeekdays" }) ?? [];
  const overrideWindow = useWatch({ control, name: "overrideWindow" });

  const selectedCustomer = mockCustomers.find((customer) => customer.id === customerId);
  const sitesForCustomer = selectedCustomer?.sites ?? [];
  const selectedSite: ServiceSite | undefined = sitesForCustomer.find(
    (site) => site.id === serviceSiteId
  );
  const selectedJobType = mockJobTypes.find((jobType) => jobType.id === jobTypeId);

  // Keep the site selection valid whenever the customer changes.
  React.useEffect(() => {
    const current = getValues("serviceSiteId");
    const stillValid = sitesForCustomer.some((site) => site.id === current);
    if (!stillValid) {
      setValue("serviceSiteId", sitesForCustomer[0]?.id ?? "");
    }
    // Only customerId changing should trigger this re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  function handleJobTypeChange(nextJobTypeId: string) {
    setValue("jobTypeId", nextJobTypeId);
    const jobType = mockJobTypes.find((candidate) => candidate.id === nextJobTypeId);
    if (jobType) {
      setValue("crewSize", jobType.defaultCrewSize);
      setValue("durationMinutes", jobType.defaultDurationMinutes);
    }
  }

  const daysExceedFrequency =
    frequencyUnit === "WEEK" && allowedWeekdays.length > 0 && frequencyCount > allowedWeekdays.length;
  const monthlyFrequencyIsHigh =
    frequencyUnit === "MONTH" && allowedWeekdays.length > 0 && frequencyCount > allowedWeekdays.length * 5;

  const closedAllowedDays = selectedSite
    ? allowedWeekdays.filter(
        (day) => !overrideWindow && !selectedSite.operatingHours.some((entry) => entry.weekday === day)
      )
    : [];

  const hasBlockingWarning = daysExceedFrequency || allowedWeekdays.length === 0;

  async function handlePreview() {
    if (!selectedSite) {
      setPreviewError("Select a customer and site first.");
      setPreview(null);
      return;
    }
    const values = getValues();
    setIsPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await computeSchedulePreview({
        frequencyCount: Number(values.frequencyCount),
        frequencyUnit: values.frequencyUnit,
        dayRules: [
          ...values.allowedWeekdays.map((weekday) => ({ weekday, kind: "ALLOWED" as const })),
          ...values.preferredWeekdays.map((weekday) => ({ weekday, kind: "PREFERRED" as const })),
        ],
        startDate: values.startDate,
        endDate: values.endDate || null,
        site: selectedSite,
        serviceWindowStartMinute: values.overrideWindow ? timeInputToMinutes(values.windowStart) : null,
        serviceWindowEndMinute: values.overrideWindow ? timeInputToMinutes(values.windowEnd) : null,
      });
      setPreview(result);
    } catch (caught) {
      setPreview(null);
      setPreviewError(
        caught instanceof SchedulePreviewError
          ? caught.message
          : "Could not generate a preview. Please try again."
      );
    } finally {
      setIsPreviewLoading(false);
    }
  }

  function onSubmit(values: ServiceAgreementFormValues) {
    const customer = mockCustomers.find((candidate) => candidate.id === values.customerId);
    const site = customer?.sites.find((candidate) => candidate.id === values.serviceSiteId);
    const jobType = mockJobTypes.find((candidate) => candidate.id === values.jobTypeId);
    if (!customer || !site || !jobType) return;

    setAgreements((current) => [
      ...current,
      {
        id: `sa-${current.length + 1}`,
        customerId: customer.id,
        customerName: customer.name,
        serviceSiteId: site.id,
        siteName: site.name,
        jobTypeId: jobType.id,
        jobTypeName: jobType.name,
        branchCode: site.branchCode,
        frequencyCount: Number(values.frequencyCount),
        frequencyUnit: values.frequencyUnit,
        crewSize: Number(values.crewSize),
        durationMinutes: Number(values.durationMinutes),
        serviceWindowStartMinute: values.overrideWindow ? timeInputToMinutes(values.windowStart) : null,
        serviceWindowEndMinute: values.overrideWindow ? timeInputToMinutes(values.windowEnd) : null,
        startDate: values.startDate,
        endDate: values.endDate || null,
        isActive: values.isActive,
        notes: values.notes || null,
        dayRules: [
          ...values.allowedWeekdays.map((weekday) => ({ weekday, kind: "ALLOWED" as const })),
          ...values.preferredWeekdays.map((weekday) => ({ weekday, kind: "PREFERRED" as const })),
        ],
      },
    ]);
    notify.success(`Service agreement for ${customer.name} added.`);
    reset(defaultValues);
    setPreview(null);
    setPreviewError(null);
    setDrawerOpen(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Service Agreements</h1>
          <p className="text-muted-foreground">
            Recurring visit frequency, allowed days and crew requirements per customer.
          </p>
        </div>
        <Button onClick={() => setDrawerOpen(true)} disabled={mockCustomers.length === 0}>
          <Plus className="h-4 w-4" />
          Add agreement
        </Button>
      </div>

      {agreements.length === 0 ? (
        <EmptyState
          title="No service agreements yet"
          description="Add an agreement to a customer to start generating recurring visits."
          actionLabel="Add agreement"
          onAction={() => setDrawerOpen(true)}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Site</TableHead>
              <TableHead>Job type</TableHead>
              <TableHead>Frequency</TableHead>
              <TableHead>Allowed days</TableHead>
              <TableHead>Preferred days</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agreements.map((agreement) => (
              <TableRow key={agreement.id}>
                <TableCell className="font-medium">{agreement.customerName}</TableCell>
                <TableCell>{agreement.siteName}</TableCell>
                <TableCell>{agreement.jobTypeName}</TableCell>
                <TableCell>
                  {agreement.frequencyCount}x / {agreement.frequencyUnit.toLowerCase()}
                </TableCell>
                <TableCell>
                  {agreement.dayRules
                    .filter((rule) => rule.kind === "ALLOWED")
                    .map((rule) => WEEKDAY_SHORT[rule.weekday])
                    .join(", ") || "—"}
                </TableCell>
                <TableCell>
                  {agreement.dayRules
                    .filter((rule) => rule.kind === "PREFERRED")
                    .map((rule) => WEEKDAY_SHORT[rule.weekday])
                    .join(", ") || "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={agreement.isActive ? "success" : "outline"}>
                    {agreement.isActive ? "Active" : "Paused"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AppDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title="Add service agreement"
        description="Allowed days are mandatory boundaries; preferred days only influence optimization within them."
        footer={
          <Button type="submit" form="agreement-form" className="w-full" disabled={hasBlockingWarning}>
            Save agreement
          </Button>
        }
      >
        <form id="agreement-form" onSubmit={handleSubmit(onSubmit)} className="space-y-6 py-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField id="customerId" label="Customer">
              <Controller
                control={control}
                name="customerId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="customerId" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {mockCustomers.map((customer) => (
                        <SelectItem key={customer.id} value={customer.id}>
                          {customer.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </FormField>

            <FormField id="serviceSiteId" label="Site">
              <Controller
                control={control}
                name="serviceSiteId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="serviceSiteId" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sitesForCustomer.map((site) => (
                        <SelectItem key={site.id} value={site.id}>
                          {site.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </FormField>
          </div>

          <FormField id="jobTypeId" label="Job type">
            <Select value={jobTypeId} onValueChange={(value) => handleJobTypeChange(value ?? "")}>
              <SelectTrigger id="jobTypeId" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {mockJobTypes.map((jobType) => (
                  <SelectItem key={jobType.id} value={jobType.id}>
                    {jobType.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {selectedJobType && (
            <p className="text-xs text-muted-foreground">
              {selectedJobType.requiresPmsSupervisor && "Requires a PMS-grade supervisor. "}
              {selectedJobType.requiredSkillCode && `Needs the ${selectedJobType.requiredSkillCode} skill. `}
              Defaults: {selectedJobType.defaultCrewSize} crew, {selectedJobType.defaultDurationMinutes} min — both
              editable below.
            </p>
          )}

          <div className="grid grid-cols-2 gap-4">
            <FormField id="frequencyCount" label="Visits" error={errors.frequencyCount?.message}>
              <Input
                id="frequencyCount"
                type="number"
                min={1}
                {...register("frequencyCount", {
                  required: "Required",
                  valueAsNumber: true,
                  min: { value: 1, message: "Must be at least 1" },
                })}
              />
            </FormField>
            <FormField id="frequencyUnit" label="Per">
              <Controller
                control={control}
                name="frequencyUnit"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="frequencyUnit" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="WEEK">Week</SelectItem>
                      <SelectItem value="MONTH">Month</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField id="crewSize" label="Crew size" error={errors.crewSize?.message}>
              <Input
                id="crewSize"
                type="number"
                min={1}
                {...register("crewSize", {
                  required: "Required",
                  valueAsNumber: true,
                  min: { value: 1, message: "Must be at least 1" },
                })}
              />
            </FormField>
            <FormField id="durationMinutes" label="Duration (minutes)" error={errors.durationMinutes?.message}>
              <Input
                id="durationMinutes"
                type="number"
                min={1}
                {...register("durationMinutes", {
                  required: "Required",
                  valueAsNumber: true,
                  min: { value: 1, message: "Must be at least 1" },
                })}
              />
            </FormField>
          </div>

          <Controller
            control={control}
            name="allowedWeekdays"
            render={({ field }) => (
              <WeekdayCheckboxGroup
                idPrefix="allowed"
                legend="Allowed days"
                hint="Hard constraint — a visit may only fall on one of these days."
                selected={field.value}
                onChange={(next) => {
                  field.onChange(next);
                  // A preferred day is only meaningful if it's still allowed.
                  const stillAllowed = getValues("preferredWeekdays").filter((day) => next.includes(day));
                  setValue("preferredWeekdays", stillAllowed);
                }}
              />
            )}
          />

          <Controller
            control={control}
            name="preferredWeekdays"
            render={({ field }) => (
              <WeekdayCheckboxGroup
                idPrefix="preferred"
                legend="Preferred days"
                hint="Soft preference used for ranking — never excludes a day, and never widens the allowed set."
                selected={field.value}
                onChange={field.onChange}
                restrictTo={allowedWeekdays}
                disabledHint="Only an allowed day can be marked preferred."
              />
            )}
          />

          {allowedWeekdays.length === 0 && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Select at least one allowed day.
            </p>
          )}
          {daysExceedFrequency && (
            <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {frequencyCount} visits/week requested, but only {allowedWeekdays.length} day(s) are allowed. Reduce
              visits or allow more days.
            </p>
          )}
          {monthlyFrequencyIsHigh && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {frequencyCount} visits/month is unusually high for {allowedWeekdays.length} allowed day(s) — double
              check this is intended.
            </p>
          )}
          {closedAllowedDays.length > 0 && selectedSite && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {selectedSite.name} has no opening hours on{" "}
              {closedAllowedDays.map((day) => WEEKDAY_SHORT[day]).join(", ")} — set an hours override below, or
              those allowed days may not be schedulable.
            </p>
          )}

          <div className="space-y-3 rounded-xl border p-4">
            <div className="flex items-center gap-2">
              <Controller
                control={control}
                name="overrideWindow"
                render={({ field }) => (
                  <Checkbox
                    id="overrideWindow"
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked === true)}
                  />
                )}
              />
              <Label htmlFor="overrideWindow" className="font-normal">
                Use a specific service window instead of the site&apos;s opening hours
              </Label>
            </div>
            {overrideWindow && (
              <div className="grid grid-cols-2 gap-4">
                <FormField id="windowStart" label="Window starts">
                  <input
                    id="windowStart"
                    type="time"
                    {...register("windowStart")}
                    className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                </FormField>
                <FormField id="windowEnd" label="Window ends">
                  <input
                    id="windowEnd"
                    type="time"
                    {...register("windowEnd")}
                    className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                </FormField>
              </div>
            )}
            {selectedSite && !overrideWindow && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {selectedSite.name}&apos;s opening hours (read-only — edit from the Customers page)
                </p>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-4">
                  {WEEKDAYS.map((day) => {
                    const hours = selectedSite.operatingHours.find((entry) => entry.weekday === day);
                    return (
                      <li key={day}>
                        {WEEKDAY_SHORT[day]}:{" "}
                        {hours ? `${formatMinutes(hours.opensAtMinute)}–${formatMinutes(hours.closesAtMinute)}` : "Closed"}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField id="startDate" label="Start date" error={errors.startDate?.message}>
              <Input
                id="startDate"
                type="date"
                {...register("startDate", { required: "Start date is required" })}
              />
            </FormField>
            <FormField id="endDate" label="End date (optional — ongoing if blank)">
              <Input id="endDate" type="date" {...register("endDate")} />
            </FormField>
          </div>

          <div className="flex items-center gap-2">
            <Controller
              control={control}
              name="isActive"
              render={({ field }) => (
                <Checkbox
                  id="isActive"
                  checked={field.value}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                />
              )}
            />
            <Label htmlFor="isActive" className="font-normal">
              Active (uncheck to save as paused)
            </Label>
          </div>

          <FormField id="notes" label="Notes (optional)">
            <Textarea id="notes" {...register("notes")} />
          </FormField>

          <div className="space-y-3 rounded-xl border bg-muted/40 p-4">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-medium">
                <CalendarClock className="h-4 w-4" aria-hidden="true" />
                Schedule preview
              </h3>
              <Button type="button" variant="outline" size="sm" onClick={handlePreview}>
                {isPreviewLoading ? "Loading…" : "Preview"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Illustrative only — the next few visits assuming today&apos;s inputs. The real schedule is generated
              by the system and can differ once crew and vehicle availability are applied.
            </p>

            {isPreviewLoading ? (
              <p role="status" className="text-sm text-muted-foreground">
                Calculating preview…
              </p>
            ) : previewError ? (
              <p role="alert" className="text-sm text-destructive">
                {previewError}
              </p>
            ) : preview && preview.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {preview.map((visit) => (
                  <li key={visit.date} className="flex items-center justify-between">
                    <span>
                      {visit.date} ({WEEKDAY_SHORT[visit.weekday]})
                      {visit.isPreferredDay && (
                        <Badge variant="success" className="ml-2">
                          Preferred
                        </Badge>
                      )}
                    </span>
                    <span className="text-muted-foreground">
                      {formatMinutes(visit.windowStartMinute)}–{formatMinutes(visit.windowEndMinute)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : preview ? (
              <p className="text-sm text-muted-foreground">
                No visits fall in the preview window with these settings.
              </p>
            ) : null}
          </div>
        </form>
      </AppDrawer>
    </div>
  );
}
