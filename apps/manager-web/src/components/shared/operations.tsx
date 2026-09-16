"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, Info, Users, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatDayRange, formatStamp, formatStampDay } from "@/lib/calendar";
import { cn } from "@/lib/utils";
import {
  isDispatchableOperation,
  type OperationState,
  type OperationsPublishedAssignmentLineageEntry,
  type OperationsDayItem,
  type OperationsDayResponse,
  type OperationsPublishedAssignmentProvenance,
  type OperationsScheduleVersion,
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

const DISPATCHED_VERSION_STATUSES = ["PUBLISHED", "ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED"];

/**
 * How a schedule run is named on screen.
 *
 * It used to be named by its id — "Published schedule version
 * 6a1d0f2e-9c4b-…", nineteen times down a day's list, which tells a manager
 * nothing they can do anything with and makes every row look different from
 * every other. A run is recognised by the weeks it covers and the moment it
 * was published, both of which the read model now carries; the id stays in the
 * payload only because the link to Schedule History is built from the fact
 * that a run exists, never printed.
 */
function scheduleRunLabel(version: OperationsScheduleVersion, isDispatched: boolean): string {
  const horizon =
    version.rangeStart && version.rangeEnd
      ? ` ${formatDayRange(version.rangeStart, version.rangeEnd)}`
      : "";
  const status = version.status?.toUpperCase();

  if (isDispatched) {
    const stamp = version.publishedAt ? formatStamp(version.publishedAt) : "";
    return `Published schedule${horizon}${stamp ? `, published ${stamp}` : ""}`;
  }
  const kind = status === "DRAFT" ? "Draft schedule" : "Schedule";
  return `${kind}${horizon} — not dispatch truth`;
}

function ScheduleLineage({ item }: { item: OperationsDayItem }) {
  const version = item.scheduleVersion;
  if (!version) return null;
  const isDispatched = DISPATCHED_VERSION_STATUSES.includes(version.status?.toUpperCase());
  const label = scheduleRunLabel(version, isDispatched);

  return (
    <p className="mt-2 text-xs text-muted-foreground">
      {version.id ? (
        <Link
          href={`/schedule-history?run=${encodeURIComponent(version.id)}`}
          className="underline underline-offset-2"
        >
          {label}
        </Link>
      ) : (
        label
      )}
    </p>
  );
}

const PROVENANCE_LABELS: Record<OperationsPublishedAssignmentProvenance, string> = {
  SCHEDULE_RUN: "a schedule run",
  REPAIR: "an audited repair",
  MANUAL_PUBLISH: "a manual publish",
};

/**
 * How a published version is referred to on screen.
 *
 * By its place in the chain and by what produced it, never by eight
 * characters of a uuid. "supersedes 8f2c1a0b…" is a string a manager can
 * neither search for nor read out to a colleague, and three of them on one
 * line turned a correction story into a hash.
 */
function provenancePhrase(entry: OperationsPublishedAssignmentLineageEntry): string {
  if (entry.provenance !== "REPAIR") return PROVENANCE_LABELS[entry.provenance];
  return entry.publishedAt
    ? `the audited repair of ${formatStampDay(entry.publishedAt)}`
    : "an audited repair";
}

/**
 * The per-visit story of published work: which version is current, what each
 * one superseded, and whether a repair produced it. Schedule-run history is a
 * different thing and stays in its own line above.
 */
function PublishedAssignmentLineage({ item }: { item: OperationsDayItem }) {
  const lineage = item.publishedAssignmentLineage;
  if (lineage.entries.length === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        No published assignment history for this visit yet.
      </p>
    );
  }

  return (
    <section
      className="mt-3 rounded-md border bg-muted/30 p-2 text-xs"
      aria-label="Published assignment history"
    >
      <h3 className="font-medium text-foreground">Published assignment history</h3>
      {lineage.truncated && (
        <p className="mt-1 text-muted-foreground" role="note">
          Showing the {lineage.entries.length} most recent of {lineage.totalCount} published versions
          — {lineage.omittedCount} older {lineage.omittedCount === 1 ? "version is" : "versions are"} not shown.
        </p>
      )}
      {lineage.withdrawn && (
        <p className="mt-1 text-muted-foreground">
          The published work was withdrawn; no version is current.
        </p>
      )}
      {lineage.hasMixedProvenance && (
        <p className="mt-1 text-muted-foreground">
          This visit mixes scheduled and repaired published versions.
        </p>
      )}
      <ol className="mt-1 space-y-1 text-muted-foreground">
        {lineage.entries.map((entry, index) => {
          // Counted from the whole chain, not from what fitted on screen, so
          // "Version 12 of 13" stays true under truncation.
          const numberOf = (position: number) =>
            lineage.totalCount - lineage.entries.length + position + 1;
          const predecessor = entry.supersedesAssignmentId
            ? lineage.entries.findIndex(
                (candidate) => candidate.assignmentId === entry.supersedesAssignmentId,
              )
            : -1;

          return (
            <li key={entry.assignmentId} className={cn(entry.isCurrent && "text-foreground")}>
              <span className="font-medium">
                Version {numberOf(index)} of {lineage.totalCount}
              </span>{" "}
              ·{" "}
              {entry.isCurrent
                ? "current published version"
                : entry.status.toLowerCase().replaceAll("_", " ")}{" "}
              · from {provenancePhrase(entry)}
              {entry.supersedesAssignmentId
                ? predecessor >= 0
                  ? ` · replaces version ${numberOf(predecessor)}`
                  : " · replaces an earlier version"
                : ""}
              {!entry.supersededByAssignmentId && !entry.isCurrent && lineage.withdrawn
                ? " · withdrawn, not replaced"
                : ""}
            </li>
          );
        })}
      </ol>
    </section>
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
        {/*
          * The written reason, not the engine's code. "EMPLOYEE_DOUBLE_BOOKED:
          * This employee is already assigned to another visit at this time"
          * shouted an internal name above a sentence that already said it, and
          * made a handled refusal look like a crash. `violation.code` stays on
          * the wire for support.
          */}
        {violations.map((violation) => (
          <li key={`${violation.code}-${violation.message}`} className="text-foreground">
            {violation.message}
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
      <PublishedAssignmentLineage item={item} />
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
