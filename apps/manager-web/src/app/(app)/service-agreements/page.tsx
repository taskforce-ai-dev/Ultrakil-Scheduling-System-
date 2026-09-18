"use client";

import * as React from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { AlertTriangle, CalendarClock, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
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
  confirmVisitGeneration,
  createServiceAgreement,
  fetchCustomers,
  fetchJobTypes,
  fetchServiceAgreements,
  fetchSkills,
  previewVisitGeneration,
  type Customer,
  type GenerationImpact,
  type JobType,
  type ServiceAgreement,
  type ServiceSite,
  type SkillListItem,
} from "@/lib/api-client";
import { describeFrequency } from "@/lib/cadence";
import { formatDurationMinutes, formatLongDate, rangeForGeneration, todayIso } from "@/lib/calendar";
import { WEEKDAYS, type Weekday } from "@/lib/weekdays";
import { notify } from "@/lib/notify";

interface ServiceAgreementFormValues {
  customerId: string;
  serviceSiteId: string;
  jobTypeId: string;
  frequencyCount: number;
  frequencyInterval: number;
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

/**
 * The range the post-save schedule preview asks about: from today (or the
 * agreement's own start date, if that's later) through the first month grid
 * that reaches — the same one-month-out horizon a manager gets generating
 * from the Calendar page, so a brand-new agreement's first look matches what
 * every other Generate Visits action already shows.
 */
function schedulingWindow(startDate: string): { from: string; to: string } {
  const from = startDate > todayIso() ? startDate : todayIso();
  return { from, to: rangeForGeneration(from, "month").to };
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

/**
 * The API has no "all statuses" mode: omitting `status` returns ACTIVE and
 * PAUSED, and archived agreements are hidden (see
 * `apps/api/src/catalog/agreements.service.ts`). An import marks an agreement
 * it read as no longer serviced ARCHIVED — so "Archived" here is also the only
 * manager-facing way to find an imported-inactive agreement. It is a
 * deliberate, separate look, and it is read-only: an archived agreement offers
 * no Pause/Resume control and is never schedulable.
 */
type AgreementStatusFilter = "CURRENT" | "ARCHIVED";
// Base UI's <SelectValue> renders the raw value unless the root is given a
// value -> label map; "CURRENT" is not something a manager should read.
const AGREEMENT_STATUS_FILTER_LABEL: Record<AgreementStatusFilter, string> = {
  CURRENT: "Active & paused",
  ARCHIVED: "Archived",
};

/**
 * An agreement that has generated nothing is invisible everywhere else.
 *
 * Two testers found the same customer independently: an active two-monthly
 * agreement with no visits in September, October, November or December. It
 * appears on no calendar, in no queue and in no schedule run — there is
 * nothing of it to appear — so the only screen that can raise it is this one.
 * The row says so, and this filter gathers them.
 */
type VisitsFilter = "ANY" | "NONE";
const VISITS_FILTER_LABEL: Record<VisitsFilter, string> = {
  ANY: "Any",
  NONE: "None generated",
};
const NO_VISITS_LABEL = "No visits generated";

/**
 * An agreement's *own* service window, or a plain statement that it has none.
 *
 * Never substitute the site's hours (or a default like 08:00–17:00) as if they
 * were the agreement's: imported default hours are unconfirmed elsewhere in the
 * portal and are not this agreement's fact. A half-open window is possible in
 * the data — the API only rejects an end at or before a start — so say which
 * half is set rather than rounding it down to "no window".
 */
// The API accepts an end at minute 1440, the following midnight. Hour 24 has
// no clock reading of its own, and folding it into "12:00 PM" would show an
// end-of-day window as ending at noon.
function formatWindowMinute(minute: number): string {
  return minute === 24 * 60 ? "midnight" : formatMinutes(minute);
}

function describeServiceWindow(agreement: ServiceAgreement): string {
  const { serviceWindowStartMinute: start, serviceWindowEndMinute: end } = agreement;
  if (start != null && end != null)
    return `${formatWindowMinute(start)} – ${formatWindowMinute(end)}`;
  if (start != null) return `From ${formatWindowMinute(start)}`;
  if (end != null) return `Until ${formatWindowMinute(end)}`;
  return "Site's hours apply";
}

const defaultValues: ServiceAgreementFormValues = {
  customerId: "",
  serviceSiteId: "",
  jobTypeId: "",
  frequencyCount: 1,
  frequencyInterval: 1,
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
 * `/visit-generation/preview` and `/confirm` only work on an *existing*
 * agreement's own id — there is no dry-run endpoint — so "preview before
 * saving" becomes "save, then immediately preview the real schedule before
 * the drawer closes" rather than a preview on unsaved draft values.
 *
 * The preview is scoped to `serviceAgreementIds: [agreement.id]`, which the
 * backend guarantees can only place or move *this* agreement's own visits —
 * another agreement's visit enters only as standing load, counted but never
 * moved (see the scoped-generation regression test on the API side). That
 * guarantee is what the "existing work was not moved" line below states
 * outright rather than leaving a manager to assume it.
 */
export default function ServiceAgreementsPage() {
  const [agreements, setAgreements] = React.useState<ServiceAgreement[]>([]);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [jobTypes, setJobTypes] = React.useState<JobType[]>([]);
  const [skills, setSkills] = React.useState<SkillListItem[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<AgreementStatusFilter>("CURRENT");
  const [visitsFilter, setVisitsFilter] = React.useState<VisitsFilter>("ANY");
  // Switching the filter fires a second list request while the first may still
  // be in flight; without this an older response can land last and repopulate
  // the table with the rows the manager just filtered away.
  const requestGeneration = React.useRef(0);

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
  const [impact, setImpact] = React.useState<GenerationImpact | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = React.useState(false);
  const [isScheduling, setIsScheduling] = React.useState(false);
  // A ref alongside the state: two clicks fired in the same tick (a fast
  // double-click) both close over the same pre-update `isScheduling`, so the
  // state check alone can't stop the second one.
  const isSchedulingRef = React.useRef(false);

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
  const frequencyCount = useWatch({ control, name: "frequencyCount" });
  const frequencyInterval = useWatch({ control, name: "frequencyInterval" });
  const frequencyUnit = useWatch({ control, name: "frequencyUnit" });
  const durationMinutes = useWatch({ control, name: "durationMinutes" });
  // The slider's own displayed position only — never what's actually saved.
  // A manager who types 47 keeps exactly 47 in the field and on submission;
  // this just gives the thumb a valid, in-range spot to sit at meanwhile.
  // Floored at 15, not 1: the slider's own min is 15 (see below) so its grid
  // lands on real quarter-hours — 15, 30, 45… — instead of 1, 16, 31…
  const sliderDurationMinutes = Number.isFinite(durationMinutes)
    ? Math.min(Math.max(durationMinutes, 15), 1440)
    : 15;
  // A half-typed number field reads back NaN; say nothing rather than
  // "NaN times a week".
  const cadencePreview =
    Number.isFinite(frequencyCount) &&
    Number.isFinite(frequencyInterval) &&
    frequencyCount >= 1 &&
    frequencyInterval >= 1
      ? describeFrequency(frequencyCount, frequencyUnit, frequencyInterval).toLowerCase()
      : "not set yet";

  const selectedCustomer = customers.find((customer) => customer.id === customerId);
  // ULK-O09: an inactive site must never be offered when creating an
  // agreement, even for an otherwise-active customer — customers.sites is
  // unfiltered by the API (it's the customer-level `active` param that's
  // filtered, not the nested sites), so this has to filter client-side.
  const sitesForCustomer = (selectedCustomer?.sites ?? []).filter((site) => site.isActive);
  const customerLabels = Object.fromEntries(
    customers.map((customer) => [customer.id, customer.name])
  );
  const siteLabels = Object.fromEntries(sitesForCustomer.map((site) => [site.id, site.name]));
  const selectedSite: ServiceSite | undefined = sitesForCustomer.find(
    (site) => site.id === serviceSiteId
  );
  const selectedJobType = jobTypes.find((jobType) => jobType.id === jobTypeId);

  const load = React.useCallback(() => {
    const generation = ++requestGeneration.current;
    setIsLoading(true);
    setError(null);
    Promise.all([
      fetchServiceAgreements({
        pageSize: 200,
        ...(statusFilter === "ARCHIVED" ? { status: "ARCHIVED" as const } : {}),
        ...(visitsFilter === "NONE" ? { withoutVisits: true } : {}),
      }),
      fetchCustomers({ pageSize: 200 }),
      fetchJobTypes(),
      fetchSkills(),
    ])
      .then(([agreementPage, customerPage, jobTypeList, skillList]) => {
        if (generation !== requestGeneration.current) return;
        setAgreements(agreementPage.items);
        setCustomers(customerPage.items);
        setJobTypes(jobTypeList);
        setSkills(skillList);
      })
      .catch((caught: unknown) => {
        if (generation !== requestGeneration.current) return;
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => {
        if (generation === requestGeneration.current) setIsLoading(false);
      });
  }, [statusFilter, visitsFilter]);

  // A handler that awaited a request resumes holding the `load` of the render
  // it started in. If the Status filter changed meanwhile, that stale `load`
  // would refresh with the old filter and win the generation race, showing
  // current agreements under a control that says Archived. Refresh through
  // the latest one instead.
  const loadRef = React.useRef(load);
  React.useEffect(() => {
    loadRef.current = load;
  }, [load]);
  const reload = React.useCallback(() => loadRef.current(), []);

  React.useEffect(() => {
    // Fetching from the API on mount — an external system, which is what
    // effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => {
      requestGeneration.current += 1;
    };
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
    setImpact(null);
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
        frequencyInterval: Number(values.frequencyInterval),
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
        const { from, to } = schedulingWindow(agreement.startDate);
        const result = await previewVisitGeneration({
          from,
          to,
          branchCode: agreement.branchCode,
          serviceAgreementIds: [agreement.id],
        });
        setImpact(result);
      } catch (caught) {
        setPreviewError(
          caught instanceof ApiError ? caught.message : "Could not calculate the schedule."
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

  async function handleScheduleNow() {
    if (!createdAgreement || isSchedulingRef.current) return; // Collapses a double-click into one request.
    isSchedulingRef.current = true;
    setIsScheduling(true);
    try {
      const { from, to } = schedulingWindow(createdAgreement.startDate);
      const result = await confirmVisitGeneration({
        from,
        to,
        branchCode: createdAgreement.branchCode,
        serviceAgreementIds: [createdAgreement.id],
      });
      setImpact(result);
      notify.success(
        result.additions.length === 0
          ? "Nothing to schedule yet — check the conflicts below."
          : `${result.additions.length} ${result.additions.length === 1 ? "visit" : "visits"} scheduled for ${createdAgreement.customerName}.`
      );
    } catch (caught) {
      notify.error(
        caught instanceof ApiError ? caught.message : "Could not schedule the visits."
      );
    } finally {
      isSchedulingRef.current = false;
      setIsScheduling(false);
    }
  }

  function handleDone() {
    setDrawerOpen(false);
    reload();
  }

  async function handleToggleStatus(agreement: ServiceAgreement) {
    if (busyAgreementIdRef.current) return; // Collapses a double-click into one request.
    busyAgreementIdRef.current = agreement.id;
    setBusyAgreementId(agreement.id);
    const nextStatus = agreement.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    try {
      await changeAgreementStatus(agreement.id, { status: nextStatus });
      notify.success(`${agreement.customerName}'s agreement is now ${STATUS_LABEL[nextStatus]}.`);
      reload();
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

      <div className="flex flex-wrap items-end gap-4 rounded-xl border bg-card p-4 shadow-sm">
        <div className="space-y-1.5">
          <Label htmlFor="agreements-status">Status</Label>
          <Select
            items={AGREEMENT_STATUS_FILTER_LABEL}
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as AgreementStatusFilter)}
          >
            <SelectTrigger id="agreements-status" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="CURRENT">Active &amp; paused</SelectItem>
              <SelectItem value="ARCHIVED">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="agreements-visits">Visits generated</Label>
          <Select
            items={VISITS_FILTER_LABEL}
            value={visitsFilter}
            onValueChange={(value) => setVisitsFilter((value ?? "ANY") as VisitsFilter)}
          >
            <SelectTrigger id="agreements-visits" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ANY">{VISITS_FILTER_LABEL.ANY}</SelectItem>
              <SelectItem value="NONE">{VISITS_FILTER_LABEL.NONE}</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
        statusFilter === "ARCHIVED" ? (
          <EmptyState
            title="No archived agreements"
            description="Nothing on record has been archived, by a manager or by an import."
          />
        ) : (
          <EmptyState
            title="No service agreements yet"
            description="Add an agreement to a customer to start generating recurring visits."
            actionLabel="Add agreement"
            onAction={openDrawer}
          />
        )
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Site</TableHead>
              <TableHead>Job type</TableHead>
              <TableHead>Frequency</TableHead>
              {/* ULK-O08: crew size and the service window are both set on
                  Add agreement and were then invisible once saved. Read-only
                  columns — editing an agreement is not part of this. */}
              <TableHead>Crew size</TableHead>
              <TableHead>Service window</TableHead>
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
                {/* The API's own words for this cadence, interval and all.
                    Composing them here from frequencyCount and frequencyUnit
                    dropped frequencyInterval, and every fortnightly agreement
                    read as weekly. */}
                <TableCell>{agreement.frequencyLabel}</TableCell>
                <TableCell>
                  {agreement.crewSize} {agreement.crewSize === 1 ? "person" : "people"}
                </TableCell>
                <TableCell
                  className={
                    agreement.serviceWindowStartMinute == null &&
                    agreement.serviceWindowEndMinute == null
                      ? "text-muted-foreground"
                      : undefined
                  }
                >
                  {describeServiceWindow(agreement)}
                </TableCell>
                <TableCell>
                  {agreement.allowedDays.map((day) => WEEKDAY_SHORT[day]).join(", ") || "—"}
                </TableCell>
                <TableCell>
                  {agreement.preferredDays.map((day) => WEEKDAY_SHORT[day]).join(", ") || "—"}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={agreement.status === "ACTIVE" ? "success" : "outline"}>
                      {STATUS_LABEL[agreement.status]}
                    </Badge>
                    {/* In words, never colour alone — and inside the Status
                        cell rather than an eleventh column, which this table
                        has no room for at tablet width. */}
                    {agreement.status !== "ARCHIVED" && agreement.generatedVisitCount === 0 && (
                      <Badge variant="destructive">
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                        {NO_VISITS_LABEL}
                      </Badge>
                    )}
                  </div>
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
            <div className="flex w-full gap-2">
              {impact?.isPreview && impact.additions.length > 0 && (
                <Button className="flex-1" onClick={handleScheduleNow} disabled={isScheduling}>
                  {isScheduling ? "Scheduling…" : "Schedule now"}
                </Button>
              )}
              <Button
                variant={impact?.isPreview && impact.additions.length > 0 ? "outline" : "default"}
                className="flex-1"
                onClick={handleDone}
              >
                Done
              </Button>
            </div>
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
                {createdAgreement.frequencyLabel}
              </p>
            </div>

            <div className="space-y-3 rounded-xl border p-4">
              <h3 className="flex items-center gap-1.5 text-sm font-medium">
                <CalendarClock className="h-4 w-4" aria-hidden="true" />
                {impact && !impact.isPreview ? "Scheduled" : "Schedule"}
              </h3>

              {/*
                Stated unconditionally, not only once visits exist: the
                guarantee holds whether this run finds zero visits, a
                shortfall, or a full month, and a manager reading a conflict
                below still needs to know nobody else's calendar moved.
              */}
              <p className="text-xs text-muted-foreground">
                This only plans {createdAgreement.customerName}&apos;s own visits — every
                other customer&apos;s existing schedule is untouched.
              </p>

              {isPreviewLoading ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Scheduling in progress…
                </p>
              ) : previewError ? (
                <p role="alert" className="text-sm text-destructive">
                  {previewError}
                </p>
              ) : impact ? (
                <>
                  <p className="text-sm">
                    {impact.additions.length === 0
                      ? "No visits could be placed in the next month — see the conflicts below."
                      : `${impact.additions.length} ${
                          impact.additions.length === 1 ? "visit" : "visits"
                        } ${impact.isPreview ? "ready to schedule" : "scheduled"} between ${formatLongDate(
                          impact.from
                        )} and ${formatLongDate(impact.to)}.`}
                  </p>

                  {impact.additions.length > 0 && (
                    <ul className="space-y-1.5 text-sm">
                      {impact.additions.map((visit, index) => (
                        <li
                          key={`${visit.visitDate}-${index}`}
                          className="flex items-center justify-between gap-2"
                        >
                          <span>
                            {formatLongDate(visit.visitDate)}
                            {visit.isPreferredDay && (
                              <Badge variant="success" className="ml-2">
                                Preferred
                              </Badge>
                            )}
                          </span>
                          <span className="text-right text-muted-foreground">
                            {formatMinutes(visit.windowStartMinute)}–
                            {formatMinutes(visit.windowEndMinute)} · crew of{" "}
                            {visit.requiredCrewSize}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {(impact.shortfalls.length > 0 || impact.loadWarnings.length > 0) && (
                    <div className="space-y-2">
                      <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                        Unresolved conflicts
                      </h4>
                      {impact.shortfalls.map((shortfall, index) => (
                        <p
                          key={`shortfall-${index}`}
                          className="flex items-start gap-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                        >
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          {shortfall.message}
                        </p>
                      ))}
                      {impact.loadWarnings.map((warning, index) => (
                        <p
                          key={`load-${index}`}
                          className="flex items-start gap-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                        >
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          {warning.message}
                        </p>
                      ))}
                    </div>
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
            // react-hook-form owns every validation message here, shown
            // through FormField's own error text. Without this, the
            // browser's native constraint validation also runs — and the
            // duration slider's hidden range input (min 1, step 15) reports
            // a step mismatch for any value not on that exact grid, which
            // silently blocks the whole form's submission before RHF or its
            // onSubmit handler ever runs, for every field, not only duration.
            noValidate
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
                    <Select
                      items={customerLabels}
                      value={field.value}
                      onValueChange={field.onChange}
                    >
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
                    <Select
                      items={siteLabels}
                      value={field.value}
                      onValueChange={field.onChange}
                    >
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

            {/* Three controls, not two. A cadence is visits-per-cycle *and*
                how long the cycle is: without the interval there was no way
                to write down a fortnightly or a quarterly agreement at all,
                and every one of them had to be created as weekly or monthly
                and corrected in the database. */}
            <div className="grid grid-cols-3 gap-4">
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
              <FormField
                id="frequencyInterval"
                label="Every"
                error={errors.frequencyInterval?.message}
              >
                <Input
                  id="frequencyInterval"
                  type="number"
                  min={1}
                  max={12}
                  {...register("frequencyInterval", {
                    required: "Required",
                    valueAsNumber: true,
                    min: { value: 1, message: "Must be at least 1" },
                    // The API rejects anything past 12 (CreateServiceAgreementDto).
                    max: { value: 12, message: "12 is the longest cycle" },
                  })}
                />
              </FormField>
              <FormField id="frequencyUnit" label="Week or month">
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
            {/* Named back before it is saved. Three numeric controls do not
                add up to a cadence in anyone's head, and "1 / 2 / Week" is
                exactly the shape a manager needs told back as "Fortnightly". */}
            <p className="text-xs text-muted-foreground">
              This agreement is <span className="font-medium">{cadencePreview}</span>.
            </p>

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
                <div className="space-y-2">
                  <Input
                    id="durationMinutes"
                    type="number"
                    min={1}
                    max={1440}
                    {...register("durationMinutes", {
                      required: "Required",
                      valueAsNumber: true,
                      min: { value: 1, message: "Must be at least 1 minute" },
                      // The API rejects anything past 1440 (a full day) —
                      // CreateServiceAgreementDto's own durationMinutes bound.
                      max: {
                        value: 1440,
                        message: "1440 minutes (24 hours) is the longest a single visit can run",
                      },
                    })}
                  />
                  <Slider
                    aria-label="Job duration"
                    // A quarter-hour grid has to start on a quarter-hour: with
                    // min={1} the grid was 1, 16, 31… — a step off true 15s,
                    // so Arrow Right from the 60-minute default landed on 76,
                    // not 75. min=15 makes every step a real 15/30/45/60…
                    // The field itself still keeps the API's real 1-1440
                    // bound — this only changes where the slider's own steps
                    // fall.
                    min={15}
                    max={1440}
                    step={15}
                    value={sliderDurationMinutes}
                    onValueChange={(value) =>
                      setValue("durationMinutes", value as number, {
                        shouldValidate: true,
                        shouldDirty: true,
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {Number.isFinite(durationMinutes)
                      ? formatDurationMinutes(durationMinutes)
                      : "Enter a duration"}
                  </p>
                </div>
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

            {/*
              The start date is not only when the work begins: `periodIndexOf`
              counts a fortnightly agreement's fortnights and a quarterly one's
              quarters from it, so moving it re-phases every future period —
              and a visit already generated under the old phasing sits in a
              period the next run no longer plans.
            */}
            <p className="text-xs text-muted-foreground" id="startDate-cycle-hint">
              The start date also sets the cycle: a fortnightly or quarterly agreement counts
              its fortnights and quarters from this day, so changing it re-phases every future
              period and the next generation run may move visits.
            </p>

            <FormField id="notes" label="Notes (optional)">
              <Textarea id="notes" {...register("notes")} />
            </FormField>
          </form>
        )}
      </AppDrawer>
    </div>
  );
}
