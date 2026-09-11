"use client";

import * as React from "react";
import {
  AlertTriangle,
  Archive,
  CalendarClock,
  CheckCircle2,
  Clock3,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  applyPublishedAssignmentRepair,
  buildPublishedAssignmentRepairPlan,
  fetchPublishedAssignmentRepairFindings,
  type PublishedAssignmentRepairFinding,
  type PublishedAssignmentRepairOperation,
  type PublishedAssignmentRepairPlan,
  type PublishedAssignmentRepairPlanItem,
  type PublishedAssignmentRepairResult,
  type PublishedAssignmentRepairTimeScope,
} from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { formatLongDate } from "@/lib/calendar";

const FINDINGS_PAGE_SIZE = 100;

const SECTION_DETAILS: Record<
  PublishedAssignmentRepairTimeScope,
  { title: string; description: string; icon: React.ComponentType<{ className?: string }> }
> = {
  HISTORICAL: {
    title: "History",
    description:
      "Past published work is preserved for audit. It can be inspected here but is never rewritten automatically.",
    icon: Archive,
  },
  CURRENT_DAY: {
    title: "Today",
    description:
      "Same-day corrections need an explicit acknowledgement because a crew may already be in motion.",
    icon: CalendarClock,
  },
  FUTURE: {
    title: "Future",
    description:
      "Select only the published assignments you want the solver to repair. Nothing changes until an administrator applies the reviewed plan.",
    icon: Clock3,
  },
};

function unknownError(message: string) {
  return new ApiError({ code: "UNKNOWN_ERROR", message });
}

function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function createBrowserIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `repair-${globalThis.crypto.randomUUID()}`;
  }
  return `repair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function FindingCard({
  finding,
  selected,
  onSelectedChange,
}: {
  finding: PublishedAssignmentRepairFinding;
  selected: boolean;
  onSelectedChange?: (selected: boolean) => void;
}) {
  const selectable = finding.isSelectableForRepair && finding.timeScope !== "HISTORICAL";
  const content = (
    <div className="min-w-0 flex-1 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{finding.customerName}</p>
          <p className="text-sm text-muted-foreground">
            {finding.siteName} · {formatLongDate(finding.visitDate)}
          </p>
        </div>
        <Badge variant={finding.timeScope === "HISTORICAL" ? "secondary" : "destructive"}>
          {finding.conflicts.length} {finding.conflicts.length === 1 ? "violation" : "violations"}
        </Badge>
      </div>

      <ul className="space-y-2" aria-label={`Violations for ${finding.customerName}`}>
        {finding.conflicts.map((conflict) => (
          <li key={`${conflict.code}-${conflict.message}`} className="rounded-lg border bg-muted/35 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-semibold">{conflict.code}</span>
              <span className="text-sm">{conflict.message}</span>
            </div>
            {conflict.remediation && (
              <p className="mt-1 text-xs text-muted-foreground">{conflict.remediation}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <li className="flex items-start gap-3 rounded-xl border bg-card p-4 shadow-sm">
      {selectable && onSelectedChange ? (
        <Checkbox
          className="mt-1"
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          aria-label={`Select ${finding.customerName} at ${finding.siteName}`}
        />
      ) : (
        <Archive className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      {content}
    </li>
  );
}

function FindingSection({
  timeScope,
  findings,
  selectedIds,
  onToggle,
}: {
  timeScope: PublishedAssignmentRepairTimeScope;
  findings: PublishedAssignmentRepairFinding[];
  selectedIds: Set<string>;
  onToggle: (finding: PublishedAssignmentRepairFinding, selected: boolean) => void;
}) {
  const details = SECTION_DETAILS[timeScope];
  const Icon = details.icon;

  return (
    <section className="space-y-3" role="region" aria-label={details.title}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-lg bg-muted p-2 text-muted-foreground">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{details.title}</h2>
            <Badge variant="outline">{findings.length}</Badge>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">{details.description}</p>
        </div>
      </div>

      {findings.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
          No {details.title.toLowerCase()} findings.
        </div>
      ) : (
        <ul className="space-y-3">
          {findings.map((finding) => (
            <FindingCard
              key={finding.assignmentId}
              finding={finding}
              selected={selectedIds.has(finding.assignmentId)}
              onSelectedChange={(selected) => onToggle(finding, selected)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PlanItem({
  item,
  operation,
}: {
  item: PublishedAssignmentRepairPlanItem;
  operation?: PublishedAssignmentRepairOperation;
}) {
  if (!operation) {
    return (
      <li className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
        <p className="text-sm font-medium">The repair plan did not include an operation for this visit.</p>
      </li>
    );
  }

  return (
    <li className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{item.customerName}</p>
          <p className="text-sm text-muted-foreground">
            {item.siteName} ·
            {formatLongDate(item.visitDate)}
          </p>
        </div>
        <Badge variant={operation.action === "REPLACED" ? "success" : "destructive"}>
          {operation.action === "REPLACED" ? "Safe replacement" : "Withdraw to Unassigned Visits"}
        </Badge>
      </div>

      {operation.action === "REPLACED" && operation.replacement ? (
        <div className="mt-4 space-y-3">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Time</dt>
              <dd>
                {formatMinutes(operation.replacement.plannedStartMinute)}–
                {formatMinutes(operation.replacement.plannedEndMinute)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Crew</dt>
              <dd>
                {operation.replacement.crew.map((member) => member.employeeId).join(", ")}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Vehicle</dt>
              <dd>
                {operation.replacement.vehicles?.length
                  ? operation.replacement.vehicles.map((vehicle, index) => {
                      const driver = vehicle.driverEmployeeId;
                      return (
                        <React.Fragment key={vehicle.vehicleId}>
                          {index > 0 ? ", " : ""}
                          <span>{vehicle.vehicleId}</span>
                          {driver ? ` — driver ${driver}` : ""}
                        </React.Fragment>
                      );
                    })
                  : "Public transport only"}
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-sm font-medium">No safe replacement was available.</p>
          <ul className="mt-2 space-y-2">
            {(operation.unassignedReasons ?? []).map((reason) => (
              <li key={`${reason.code}-${reason.message}`}>
                <span className="font-mono text-xs font-semibold">{reason.code}</span>
                <p className="text-sm text-muted-foreground">{reason.message}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {item.conflicts.length > 0 && (
        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-medium text-destructive">Planner conflicts</p>
          {item.conflicts.map((conflict) => (
            <p key={`${conflict.code}-${conflict.message}`} className="mt-1 text-sm">
              <span className="font-mono text-xs">{conflict.code}</span> — {conflict.message}
            </p>
          ))}
        </div>
      )}
    </li>
  );
}

function communicationMessage(result: PublishedAssignmentRepairResult) {
  if (result.communicationState === "APPLIED_PENDING_COMMUNICATION") {
    return "Repair applied; crew communication is pending. Do not assume crews have received the corrected plan yet.";
  }
  return "Repair applied and recorded. Reloaded findings now show the remaining exceptions.";
}

export default function PublishedAssignmentRepairsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [findings, setFindings] = React.useState<PublishedAssignmentRepairFinding[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<ApiError | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [acknowledgeToday, setAcknowledgeToday] = React.useState(false);
  const [plan, setPlan] = React.useState<PublishedAssignmentRepairPlan | null>(null);
  const [isPlanning, setIsPlanning] = React.useState(false);
  const isPlanningRef = React.useRef(false);
  const [planError, setPlanError] = React.useState<ApiError | null>(null);
  const [reason, setReason] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const [isApplying, setIsApplying] = React.useState(false);
  const isApplyingRef = React.useRef(false);
  const [applyError, setApplyError] = React.useState<ApiError | null>(null);
  const [result, setResult] = React.useState<PublishedAssignmentRepairResult | null>(null);
  const [workflowMessage, setWorkflowMessage] = React.useState<string | null>(null);
  const idempotencyKeyRef = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      const all: PublishedAssignmentRepairFinding[] = [];
      let page = 1;
      let total = Number.POSITIVE_INFINITY;
      while (all.length < total) {
        const response = await fetchPublishedAssignmentRepairFindings({
          page,
          pageSize: FINDINGS_PAGE_SIZE,
        });
        all.push(...response.items);
        total = response.total;
        if (response.items.length === 0 || all.length >= total) break;
        page += 1;
      }
      setFindings(all);
    } catch (caught) {
      setLoadError(
        caught instanceof ApiError
          ? caught
          : unknownError("Could not load published assignment findings."),
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    // Read-only API load on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const grouped = React.useMemo(
    () => ({
      HISTORICAL: findings.filter((finding) => finding.timeScope === "HISTORICAL"),
      CURRENT_DAY: findings.filter((finding) => finding.timeScope === "CURRENT_DAY"),
      FUTURE: findings.filter((finding) => finding.timeScope === "FUTURE"),
    }),
    [findings],
  );

  const selectedFindings = React.useMemo(
    () => findings.filter((finding) => selectedIds.has(finding.assignmentId)),
    [findings, selectedIds],
  );
  const includesToday = selectedFindings.some((finding) => finding.timeScope === "CURRENT_DAY");

  function discardPlan() {
    setPlan(null);
    setPlanError(null);
    setApplyError(null);
    setReason("");
    setConfirmed(false);
    idempotencyKeyRef.current = null;
  }

  function toggleFinding(finding: PublishedAssignmentRepairFinding, selected: boolean) {
    if (!finding.isSelectableForRepair || finding.timeScope === "HISTORICAL") return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(finding.assignmentId);
      else next.delete(finding.assignmentId);
      return next;
    });
    setResult(null);
    setWorkflowMessage(null);
    discardPlan();
  }

  async function handleBuildPlan() {
    if (isPlanningRef.current || selectedFindings.length === 0) return;
    if (includesToday && !acknowledgeToday) return;
    isPlanningRef.current = true;
    setIsPlanning(true);
    setPlanError(null);
    setApplyError(null);
    setResult(null);
    setWorkflowMessage(null);
    try {
      const response = await buildPublishedAssignmentRepairPlan({
        sourceAssignmentIds: selectedFindings.map((finding) => finding.assignmentId),
        ...(includesToday ? { acknowledgeCurrentDay: true as const } : {}),
      });
      setPlan(response);
      setReason("");
      setConfirmed(false);
      idempotencyKeyRef.current = createBrowserIdempotencyKey();
    } catch (caught) {
      setPlan(null);
      idempotencyKeyRef.current = null;
      setPlanError(
        caught instanceof ApiError ? caught : unknownError("Could not build the repair plan."),
      );
    } finally {
      isPlanningRef.current = false;
      setIsPlanning(false);
    }
  }

  async function handleApply() {
    if (!isAdmin || !plan || isApplyingRef.current || !confirmed || !reason.trim()) {
      return;
    }
    const idempotencyKey = idempotencyKeyRef.current;
    if (!idempotencyKey) return;

    isApplyingRef.current = true;
    setIsApplying(true);
    setApplyError(null);
    setWorkflowMessage(null);
    try {
      const response = await applyPublishedAssignmentRepair({
        operations: plan.operations,
        planHash: plan.planHash,
        sourceFingerprints: plan.sourceFingerprints,
        ...(plan.items.some((item) => item.timeScope === "CURRENT_DAY")
          ? { acknowledgeCurrentDay: true as const }
          : {}),
        confirmation: true,
        reason: reason.trim(),
        idempotencyKey,
      });
      setResult(response);
      setPlan(null);
      setSelectedIds(new Set());
      setAcknowledgeToday(false);
      setReason("");
      setConfirmed(false);
      idempotencyKeyRef.current = null;
      await load();
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : unknownError("Could not apply the repair.");
      if (error.code === "RESOURCE_CONFLICT") {
        setPlan(null);
        setSelectedIds(new Set());
        setAcknowledgeToday(false);
        setReason("");
        setConfirmed(false);
        idempotencyKeyRef.current = null;
        setWorkflowMessage(
          "The schedule changed, so the stale plan was discarded. Findings were reloaded; select the work again and build a fresh plan.",
        );
        await load();
      } else {
        // Preserve the plan and its idempotency key so a safe retry is the
        // same logical request, never an accidental second repair.
        setApplyError(error);
      }
    } finally {
      isApplyingRef.current = false;
      setIsApplying(false);
    }
  }

  const planHasConflicts = plan?.items.some((item) => item.conflicts.length > 0) ?? false;
  const canApply = Boolean(
    isAdmin &&
      plan &&
      !planHasConflicts &&
      confirmed &&
      Boolean(reason.trim()) &&
      !isApplying,
  );

  return (
    <div className="mx-auto max-w-6xl space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              Published Assignment Repair Center
            </h1>
            <Badge variant="outline">Recovery control</Badge>
          </div>
          <p className="mt-1 text-muted-foreground">
            Inspect invalid published assignments, ask the scheduler for a safe correction, and
            review the exact replacement or withdrawal before anything changes.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void load()} disabled={isLoading}>
          <RefreshCw className={isLoading ? "animate-spin" : ""} aria-hidden="true" />
          Refresh findings
        </Button>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        <div>
          <p className="font-medium">Planning writes nothing</p>
          <p className="text-sm text-muted-foreground">
            Building a plan reserves no crew or vehicle and changes no published history. Apply is
            a separate, administrator-only step that revalidates the plan against current data.
          </p>
        </div>
      </div>

      {workflowMessage && (
        <div
          role="status"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          {workflowMessage}
        </div>
      )}

      {result && (
        <div role="status" className="rounded-xl border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
            <div>
              <p className="font-medium">Repair recorded</p>
              <p className="text-sm text-muted-foreground">{communicationMessage(result)}</p>
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <LoadingState rows={6} />
      ) : loadError ? (
        <ErrorState
          title="Couldn't load repair findings"
          description={loadError.message}
          code={loadError.code}
          onRetry={() => void load()}
        />
      ) : findings.length === 0 ? (
        <EmptyState
          title="No invalid published assignments"
          description="The validator found no published work that breaks the current hard rules."
        />
      ) : (
        <div className="space-y-8">
          <FindingSection
            timeScope="HISTORICAL"
            findings={grouped.HISTORICAL}
            selectedIds={selectedIds}
            onToggle={toggleFinding}
          />
          <FindingSection
            timeScope="CURRENT_DAY"
            findings={grouped.CURRENT_DAY}
            selectedIds={selectedIds}
            onToggle={toggleFinding}
          />
          <FindingSection
            timeScope="FUTURE"
            findings={grouped.FUTURE}
            selectedIds={selectedIds}
            onToggle={toggleFinding}
          />
        </div>
      )}

      {!isLoading && !loadError && findings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Build a repair plan</CardTitle>
            <CardDescription>
              {selectedFindings.length === 0
                ? "Select one or more Today or Future findings above."
                : `${selectedFindings.length} published ${selectedFindings.length === 1 ? "assignment" : "assignments"} selected.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {includesToday && (
              <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <Checkbox
                  id="acknowledge-current-day"
                  className="mt-0.5"
                  checked={acknowledgeToday}
                  onCheckedChange={(checked) => {
                    setAcknowledgeToday(checked === true);
                    discardPlan();
                  }}
                />
                <Label htmlFor="acknowledge-current-day" className="leading-5">
                  I understand today&apos;s dispatched work may already be in motion and requires
                  direct operational coordination before an applied correction is acted on.
                </Label>
              </div>
            )}

            <Button
              type="button"
              onClick={() => void handleBuildPlan()}
              disabled={
                selectedFindings.length === 0 ||
                (includesToday && !acknowledgeToday) ||
                isPlanning
              }
            >
              <Sparkles aria-hidden="true" />
              {isPlanning ? "Building plan…" : "Build repair plan"}
            </Button>

            {planError && (
              <ErrorState
                title="Couldn't build the repair plan"
                description={planError.message}
                code={planError.code}
                onRetry={() => void handleBuildPlan()}
              />
            )}
          </CardContent>
        </Card>
      )}

      {plan && (
        <section className="space-y-4" role="region" aria-label="Repair plan preview">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Repair plan preview</h2>
              <p className="text-sm text-muted-foreground">
                {plan.isValid ? "Validated" : "Needs review"} plan {plan.planHash.slice(0, 10)}…
              </p>
            </div>
            <Badge variant="outline">
              {plan.items.filter((item) => item.action === "REPLACED").length} replacements ·{" "}
              {plan.items.filter((item) => item.action === "WITHDRAWN").length} withdrawals
            </Badge>
          </div>

          <ul className="space-y-3">
            {plan.items.map((item) => (
              <PlanItem
                key={item.sourceAssignmentId}
                item={item}
                operation={plan.operations.find(
                  (operation) => operation.sourceAssignmentId === item.sourceAssignmentId,
                )}
              />
            ))}
          </ul>

          {planHasConflicts && (
            <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <p className="text-sm">
                This plan still contains conflicts and cannot be applied. Refresh findings and
                build a new plan after the underlying resource problem is resolved.
              </p>
            </div>
          )}

          {isAdmin ? (
            <Card>
              <CardHeader>
                <CardTitle>Administrator confirmation</CardTitle>
                <CardDescription>
                  Apply supersedes the exact published predecessors above. It never edits or
                  deletes their audit history.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="repair-reason">Repair reason</Label>
                  <Textarea
                    id="repair-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={500}
                    placeholder="Explain why this published correction is required"
                    aria-describedby="repair-reason-help"
                  />
                  <p id="repair-reason-help" className="text-xs text-muted-foreground">
                    Required. This is stored with the repair audit record.
                  </p>
                </div>

                <div className="flex items-start gap-3 rounded-lg border p-3">
                  <Checkbox
                    id="confirm-repair"
                    className="mt-0.5"
                    checked={confirmed}
                    onCheckedChange={(checked) => setConfirmed(checked === true)}
                  />
                  <Label htmlFor="confirm-repair" className="leading-5">
                    I confirm this will supersede published assignments and that the replacement
                    and withdrawal manifest above has been operationally reviewed.
                  </Label>
                </div>

                {applyError && (
                  <ErrorState
                    title="Repair wasn't applied"
                    description={applyError.message}
                    code={applyError.code}
                    onRetry={() => void handleApply()}
                  />
                )}

                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void handleApply()}
                  disabled={!canApply}
                >
                  <ShieldCheck aria-hidden="true" />
                  {isApplying ? "Applying repair…" : "Apply repair"}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-xl border bg-muted/35 p-4">
              <p className="font-medium">Manager review only</p>
              <p className="text-sm text-muted-foreground">
                An administrator must apply this plan after reviewing the exact outcomes with you.
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
