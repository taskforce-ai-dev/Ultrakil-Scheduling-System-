"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, Info, Users, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  isDispatchableOperation,
  type OperationState,
  type OperationsDayItem,
  type OperationsDayResponse,
} from "@/lib/api-client";

const STATE_LABELS: Record<OperationState, string> = {
  READY: "Ready",
  PROPOSED: "Proposed",
  UNASSIGNED: "Unassigned",
  EXCEPTION: "Exception",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const STATE_VARIANTS: Record<OperationState, "success" | "outline" | "destructive" | "secondary"> = {
  READY: "success",
  PROPOSED: "outline",
  UNASSIGNED: "outline",
  EXCEPTION: "destructive",
  COMPLETED: "secondary",
  CANCELLED: "secondary",
};

function StateIcon({ state }: { state: OperationState }) {
  const Icon = state === "READY" ? CheckCircle2 : state === "EXCEPTION" ? XCircle : state === "PROPOSED" ? CircleDashed : state === "UNASSIGNED" ? Users : Clock3;
  return <Icon className="h-3 w-3" aria-hidden="true" />;
}

export function OperationStateBadge({ state }: { state: OperationState }) {
  return (
    <Badge variant={STATE_VARIANTS[state]}>
      <StateIcon state={state} />
      {STATE_LABELS[state]}
    </Badge>
  );
}

function assignmentLabel(item: OperationsDayItem): string {
  if (item.state === "PROPOSED") return "Draft assignment — not dispatched";
  if (item.state === "EXCEPTION") return "Assignment needs review — not dispatchable";
  if (isDispatchableOperation(item)) return "Crew assigned";
  if (item.state === "READY") return "Ready for dispatch";
  if (item.state === "COMPLETED") return "Completed assignment";
  if (item.state === "CANCELLED") return "Cancelled — no dispatch";
  return "No crew assigned";
}

function AssignmentSummary({ item }: { item: OperationsDayItem }) {
  const assignment =
    item.state === "PROPOSED"
      ? item.proposedAssignment
      : item.dispatchAssignment ?? item.proposedAssignment;
  const names = assignment?.crew.map((member) => member.fullName).filter(Boolean).join(", ");
  const vehicles = assignment?.vehicles.map((vehicle) => vehicle.label).filter(Boolean).join(", ");

  return (
    <div className="mt-2 space-y-1 text-sm text-muted-foreground">
      <p className={cn(isDispatchableOperation(item) ? "text-foreground" : "text-muted-foreground")}>
        {assignmentLabel(item)}
      </p>
      {names && <p>Crew: {names}</p>}
      {vehicles && <p>Vehicle: {vehicles}</p>}
    </div>
  );
}

function WarningList({ item }: { item: OperationsDayItem }) {
  if (item.warnings.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-foreground" role="note">
      {item.warnings.map((warning) => (
        <p key={`${warning.code}-${warning.message}`} className="flex items-start gap-1.5">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{warning.message}</span>
        </p>
      ))}
    </div>
  );
}

function ScheduleLineage({ item }: { item: OperationsDayItem }) {
  const version = item.scheduleVersion;
  if (!version) return null;
  const versionName = version.version != null ? `v${version.version}` : version.id ?? "recorded";
  const status = version.status?.toUpperCase();
  if (["PUBLISHED", "ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED"].includes(status)) {
    return <p className="mt-2 text-xs text-muted-foreground">Published schedule version {versionName}</p>;
  }
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      {status === "DRAFT" ? "Draft schedule version" : "Schedule version"} {versionName} — not dispatch truth
    </p>
  );
}

function ViolationList({ violations }: { violations: OperationsDayItem["violations"] }) {
  if (violations.length === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm">
      <p className="flex items-center gap-1.5 font-medium text-destructive">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        Why this needs attention
      </p>
      <ul className="mt-1 space-y-1 text-muted-foreground">
        {violations.map((violation) => (
          <li key={`${violation.code}-${violation.message}`}>
            <span className="font-mono text-xs text-foreground">{violation.code}</span>: {violation.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OperationItemCard({ item, onSelect }: { item: OperationsDayItem; onSelect?: (id: string) => void }) {
  return (
    <li className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {onSelect ? (
            <button type="button" onClick={() => onSelect(item.visit.id)} className="text-left font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
              {item.visit.customerName}
            </button>
          ) : (
            <p className="font-medium">{item.visit.customerName}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {item.visit.siteName} · {item.visit.jobTypeName}
          </p>
        </div>
        <OperationStateBadge state={item.state} />
      </div>
      <AssignmentSummary item={item} />
      <p className="mt-2 text-sm">
        <span className="font-medium">Next action:</span> {item.nextAction}
      </p>
      <ScheduleLineage item={item} />
      <ViolationList violations={item.violations} />
      <WarningList item={item} />
    </li>
  );
}

export function OperationsSummaryCards({ summary }: { summary: OperationsDayResponse["summary"] }) {
  const cards = [
    ["Total", summary.total],
    ["Ready", summary.ready],
    ["Proposed", summary.proposed],
    ["Unassigned", summary.unassigned],
    ["Exceptions", summary.exceptions],
    ["Hours unconfirmed", summary.hoursUnconfirmed],
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map(([label, value]) => (
        <div key={label} className="rounded-lg border bg-card p-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function OperationsDayPanel({ data, onSelect, title = "Operational queues" }: { data: OperationsDayResponse; onSelect?: (id: string) => void; title?: string }) {
  return (
    <section className="space-y-4" aria-labelledby="operations-day-heading">
      <div>
        <h2 id="operations-day-heading" className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">
          Server-calculated dispatch state for {data.date || "the selected day"}. Drafts and exceptions are not dispatch assignments.
        </p>
      </div>
      <OperationsSummaryCards summary={data.summary} />
      {data.items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" role="status">
          No operational visits returned for this day.
        </p>
      ) : (
        <ul className="space-y-3" aria-label="Operational visits">
          {data.items.map((item) => <OperationItemCard key={item.visit.id} item={item} onSelect={onSelect} />)}
        </ul>
      )}
    </section>
  );
}
