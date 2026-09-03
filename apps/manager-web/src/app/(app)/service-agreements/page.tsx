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
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import { WeekdayCheckboxGroup } from "@/components/shared/weekday-checkbox-group";
import { timeInputToMinutes } from "@/components/shared/site-hours-editor";
import { Badge } from "@/components/ui/badge";
import {
  ApiError,
  changeAgreementStatus,
  createServiceAgreement,
  fetchCustomers,
  fetchJobTypes,
  fetchSchedulePreview,
  fetchServiceAgreements,
  fetchSkills,
  type Customer,
  type JobType,
  type ServiceAgreement,
  type ServiceSite,
  type SchedulePreview,
  type SkillListItem,
} from "@/lib/api-client";
import { WEEKDAYS, type Weekday } from "@/lib/weekdays";
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
  requiredSkillCodes: string[];
  overrideWindow: boolean;
  windowStart: string;
  windowEnd: string;
  startDate: string;
  endDate: string;
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

const STATUS_LABEL: Record<ServiceAgreement["status"], string> = {
  ACTIVE: "Active",
  PAUSED: "Paused",
  ARCHIVED: "Archived",
};

const defaultValues: ServiceAgreementFormValues = {
  customerId: "",
  serviceSiteId: "",
  jobTypeId: "",
  frequencyCount: 1,
  frequencyUnit: "WEEK",
  crewSize: 2,
  durationMinutes: 60,
  allowedWeekdays: [],
  preferredWeekdays: [],
  requiredSkillCodes: [],
  overrideWindow: false,
  windowStart: "09:00",
  windowEnd: "17:00",
  startDate: "",
  endDate: "",
  notes: "",
};

/**
 * No business-rule validation lives here on purpose — hard rules (service-area
 * matching, PMS supervisor coverage, unschedulable agreements, etc.) are
 * enforced by the API, which rejects a genuinely-impossible agreement outright
 * (400/422 with a stable code) rather than the UI second-guessing it.
 *
 * The one API-shape consequence worth calling out: `GET .../schedule-preview`
 * only works on an *existing* agreement — there is no dry-run endpoint. So
 * "preview before saving" becomes "save, then immediately show the real
 * preview before the drawer closes" rather than a preview on unsaved draft
 * values. Flagged to Chanya; a dry-run preview endpoint would be a nice
 * follow-up but isn't required for this to be correct and honest about what
 * it shows.
 */
export default function ServiceAgreementsPage() {
  const [agreements, setAgreements] = React.useState<ServiceAgreement[]>([]);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [jobTypes, setJobTypes] = React.useState<JobType[]>([]);
  const [skills, setSkills] = React.useState<SkillListItem[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  // A ref alongside the state: two submits fired in the same tick (a fast
  // double-click) both close over the same pre-update `isSubmitting`, so the
  // state check alone can't stop the second one.
  const isSubmittingRef = React.useRef(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [busyAgreementId, setBusyAgreementId] = React.useState<string | null>(null);
  const busyAgreementIdRef = React.useRef<string | null>(null);

  const [createdAgreement, setCreatedAgreement] = React.useState<ServiceAgreement | null>(null);
  const [preview, setPreview] = React.useState<SchedulePreview | null>(null);
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
  const allowedWeekdays = useWatch({ control, name: "allowedWeekdays" }) ?? [];
  const overrideWindow = useWatch({ control, name: "overrideWindow" });

  const selectedCustomer = customers.find((customer) => customer.id === customerId);
  // ULK-O09: an inactive site must never be offered when creating an
  // agreement, even for an otherwise-active customer — customers.sites is
  // unfiltered by the API (it's the customer-level `active` param that's
  // filtered, not the nested sites), so this has to filter client-side.
  const sitesForCustomer = (selectedCustomer?.sites ?? []).filter((site) => site.isActive);
  const selectedSite: ServiceSite | undefined = sitesForCustomer.find(
    (site) => site.id === serviceSiteId
  );
  const selectedJobType = jobTypes.find((jobType) => jobType.id === jobTypeId);

  const load = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    Promise.all([
      fetchServiceAgreements({ pageSize: 200 }),
      fetchCustomers({ pageSize: 200 }),
      fetchJobTypes(),
      fetchSkills(),
    ])
      .then(([agreementPage, customerPage, jobTypeList, skillList]) => {
        setAgreements(agreementPage.items);
        setCustomers(customerPage.items);
        setJobTypes(jobTypeList);
        setSkills(skillList);
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => setIsLoading(false));
  }, []);

  React.useEffect(() => {
    // Fetching from the API on mount — an external system, which is what
    // effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

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
    const jobType = jobTypes.find((candidate) => candidate.id === nextJobTypeId);
    if (jobType) {
      setValue("crewSize", jobType.defaultCrewSize);
      setValue("durationMinutes", jobType.defaultDurationMinutes);
    }
  }

  function toggleSkill(skillCode: string, checked: boolean) {
    const current = getValues("requiredSkillCodes");
    setValue(
      "requiredSkillCodes",
      checked ? [...current, skillCode] : current.filter((code) => code !== skillCode)
    );
  }

  function openDrawer() {
    setCreatedAgreement(null);
    setPreview(null);
    setPreviewError(null);
    setSubmitError(null);
    const firstCustomer = customers[0];
    const firstActiveSite = firstCustomer?.sites.find((site) => site.isActive);
    reset({
      ...defaultValues,
      customerId: firstCustomer?.id ?? "",
      serviceSiteId: firstActiveSite?.id ?? "",
    });
    setDrawerOpen(true);
  }

  async function onSubmit(values: ServiceAgreementFormValues) {
    if (isSubmittingRef.current) return; // Collapses a double-click into one request.
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const agreement = await createServiceAgreement({
        serviceSiteId: values.serviceSiteId,
        jobTypeId: values.jobTypeId,
        frequencyCount: Number(values.frequencyCount),
        frequencyUnit: values.frequencyUnit,
        crewSize: Number(values.crewSize),
        durationMinutes: Number(values.durationMinutes),
        allowedDays: values.allowedWeekdays,
        preferredDays: values.preferredWeekdays,
        serviceWindowStartMinute: values.overrideWindow
          ? timeInputToMinutes(values.windowStart)
          : null,
        serviceWindowEndMinute: values.overrideWindow
          ? timeInputToMinutes(values.windowEnd)
          : null,
        startDate: values.startDate,
        endDate: values.endDate || null,
        requiredSkillCodes: values.requiredSkillCodes,
        notes: values.notes || null,
      });

      setCreatedAgreement(agreement);
      notify.success(`Service agreement for ${agreement.customerName} created.`);

      setIsPreviewLoading(true);
      try {
        const result = await fetchSchedulePreview(agreement.id);
        setPreview(result);
      } catch (caught) {
        setPreviewError(
          caught instanceof ApiError ? caught.message : "Could not load the schedule preview."
        );
      } finally {
        setIsPreviewLoading(false);
      }
    } catch (caught) {
      setSubmitError(caught instanceof ApiError ? caught.message : "Something went wrong.");
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  function handleDone() {
    setDrawerOpen(false);
    load();
  }

  async function handleToggleStatus(agreement: ServiceAgreement) {
    if (busyAgreementIdRef.current) return; // Collapses a double-click into one request.
    busyAgreementIdRef.current = agreement.id;
    setBusyAgreementId(agreement.id);
    const nextStatus = agreement.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    try {
      await changeAgreementStatus(agreement.id, { status: nextStatus });
      notify.success(`${agreement.customerName}'s agreement is now ${STATUS_LABEL[nextStatus]}.`);
      load();
    } catch (caught) {
      notify.error(caught instanceof ApiError ? caught.message : "Could not change the status.");
    } finally {
      busyAgreementIdRef.current = null;
      setBusyAgreementId(null);
    }
  }

  const allowedDaysEmpty = allowedWeekdays.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Service Agreements</h1>
          <p className="text-muted-foreground">
            Recurring visit frequency, allowed days and crew requirements per customer.
          </p>
        </div>
        <Button onClick={openDrawer} disabled={customers.length === 0}>
          <Plus className="h-4 w-4" />
          Add agreement
        </Button>
      </div>

      {isLoading ? (
        <LoadingState rows={3} />
      ) : error ? (
        <ErrorState
          title="Couldn't load service agreements"
          description={error.message}
          code={error.code}
          onRetry={load}
        />
      ) : agreements.length === 0 ? (
        <EmptyState
          title="No service agreements yet"
          description="Add an agreement to a customer to start generating recurring visits."
          actionLabel="Add agreement"
          onAction={openDrawer}
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
              <TableHead />
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
                  {agreement.allowedDays.map((day) => WEEKDAY_SHORT[day]).join(", ") || "—"}
                </TableCell>
                <TableCell>
                  {agreement.preferredDays.map((day) => WEEKDAY_SHORT[day]).join(", ") || "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={agreement.status === "ACTIVE" ? "success" : "outline"}>
                    {STATUS_LABEL[agreement.status]}
                  </Badge>
                </TableCell>
                <TableCell>
                  {agreement.status !== "ARCHIVED" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleToggleStatus(agreement)}
                      disabled={busyAgreementId === agreement.id}
                    >
                      {busyAgreementId === agreement.id
                        ? "Working…"
                        : agreement.status === "ACTIVE"
                          ? "Pause"
                          : "Resume"}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AppDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title={createdAgreement ? "Service agreement created" : "Add service agreement"}
        description={
          createdAgreement
            ? "Here's what the system will schedule for it."
            : "Allowed days are mandatory boundaries; preferred days only influence optimization within them."
        }
        // The created-agreement view is a read-only schedule preview (no
        // form fields) — same scrollable-region-focusable case as the
        // visit-generation drawer. The form view keeps the default so the
        // Sheet's autofocus still lands on the first real field.
        contentTabIndex={Boolean(createdAgreement)}
        footer={
          createdAgreement ? (
            <Button className="w-full" onClick={handleDone}>
              Done
            </Button>
          ) : (
            <Button
              type="submit"
              form="agreement-form"
              className="w-full"
              disabled={isSubmitting || allowedDaysEmpty}
            >
              {isSubmitting ? "Saving…" : "Save agreement"}
            </Button>
          )
        }
      >
        {createdAgreement ? (
          <div className="space-y-4 py-4">
            <div className="rounded-xl border bg-muted/40 p-4 text-sm">
              <p className="font-medium">{createdAgreement.customerName}</p>
              <p className="text-muted-foreground">
                {createdAgreement.siteName} · {createdAgreement.jobTypeName} ·{" "}
                {createdAgreement.frequencyCount}x / {createdAgreement.frequencyUnit.toLowerCase()}
              </p>
            </div>

            <div className="space-y-3 rounded-xl border p-4">
              <h3 className="flex items-center gap-1.5 text-sm font-medium">
                <CalendarClock className="h-4 w-4" aria-hidden="true" />
                Schedule preview
              </h3>

              {isPreviewLoading ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Calculating preview…
                </p>
              ) : previewError ? (
                <p role="alert" className="text-sm text-destructive">
                  {previewError}
                </p>
              ) : preview ? (
                <>
                  {preview.shortfalls.length > 0 && (
                    <div className="space-y-2">
                      {preview.shortfalls.map((shortfall, index) => (
                        <p
                          key={index}
                          className="flex items-start gap-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                        >
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          {shortfall.message}
                        </p>
                      ))}
                    </div>
                  )}

                  {preview.visits.length > 0 ? (
                    <ul className="space-y-1 text-sm">
                      {preview.visits.map((visit) => (
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
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No visits fall in the preview window.
                    </p>
                  )}
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <form
            id="agreement-form"
            onSubmit={(event) => handleSubmit(onSubmit)(event)}
            className="space-y-6 py-4"
          >
            {submitError && (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {submitError}
              </p>
            )}

            <div className="grid grid-cols-2 gap-4">
              <FormField id="customerId" label="Customer">
                <Controller
                  control={control}
                  name="customerId"
                  rules={{ required: true }}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="customerId" className="w-full">
                        <SelectValue placeholder="Select a customer" />
                      </SelectTrigger>
                      <SelectContent>
                        {customers.map((customer) => (
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
                  rules={{ required: true }}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="serviceSiteId" className="w-full">
                        <SelectValue placeholder="Select a site" />
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
                  <SelectValue placeholder="Select a job type" />
                </SelectTrigger>
                <SelectContent>
                  {jobTypes.map((jobType) => (
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
                {selectedJobType.requiredSkillCode &&
                  `Needs the ${selectedJobType.requiredSkillCode} skill. `}
                Defaults: {selectedJobType.defaultCrewSize} crew, {selectedJobType.defaultDurationMinutes}{" "}
                min — both editable below.
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

            {allowedDaysEmpty && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Select at least one allowed day.
              </p>
            )}

            {skills.length > 0 && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Required skills (optional)</legend>
                <p className="text-xs text-muted-foreground">
                  On top of anything the job type already requires.
                </p>
                <div className="flex flex-wrap gap-3">
                  {skills.map((skill) => {
                    const id = `skill-${skill.skillCode}`;
                    return (
                      <div key={skill.skillCode} className="flex items-center gap-1.5">
                        <Controller
                          control={control}
                          name="requiredSkillCodes"
                          render={({ field }) => (
                            <Checkbox
                              id={id}
                              checked={field.value.includes(skill.skillCode)}
                              onCheckedChange={(checked) => toggleSkill(skill.skillCode, checked === true)}
                            />
                          )}
                        />
                        <Label htmlFor={id} className="text-sm font-normal">
                          {skill.skillLabel}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </fieldset>
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
                      const windows = selectedSite.operatingHours.filter((entry) => entry.weekday === day);
                      return (
                        <li key={day}>
                          {WEEKDAY_SHORT[day]}:{" "}
                          {windows.length === 0
                            ? "Closed"
                            : windows
                                .map((w) => `${formatMinutes(w.opensAtMinute)}–${formatMinutes(w.closesAtMinute)}`)
                                .join(", ")}
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

            <FormField id="notes" label="Notes (optional)">
              <Textarea id="notes" {...register("notes")} />
            </FormField>
          </form>
        )}
      </AppDrawer>
    </div>
  );
}
