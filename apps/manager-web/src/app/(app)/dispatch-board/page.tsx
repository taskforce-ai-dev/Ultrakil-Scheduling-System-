import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { mockDispatchVisits, mockUnassignedVisits } from "@/lib/mock-data";

/**
 * Low-fidelity screen. Crew assignment and drag/drop live with the full
 * dispatch workflow — this establishes the layout and where the
 * "no PMS supervisor" / unassigned-work signals surface.
 */
export default function DispatchBoardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dispatch Board</h1>
        <p className="text-muted-foreground">Assign crews to scheduled visits.</p>
      </div>

      {mockDispatchVisits.length === 0 ? (
        <EmptyState
          title="Nothing scheduled yet"
          description="Scheduled visits will appear here once a schedule run publishes them."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Crew</TableHead>
              <TableHead>Supervisor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mockDispatchVisits.map((visit) => (
              <TableRow key={visit.id}>
                <TableCell className="font-medium">{visit.customerName}</TableCell>
                <TableCell>{visit.branchCode}</TableCell>
                <TableCell>{visit.scheduledDate}</TableCell>
                <TableCell>{visit.crewEmployeeNames.join(", ")}</TableCell>
                <TableCell>
                  {visit.hasPmsSupervisor ? (
                    <span className="inline-flex items-center gap-1 text-sm text-emerald-600">
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Covered
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-sm text-destructive">
                      <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Missing
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {mockUnassignedVisits.length > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-amber-300/50 bg-amber-50 p-4 dark:bg-amber-950/20">
          <div>
            <p className="font-medium">{mockUnassignedVisits.length} visit(s) unassigned</p>
            <p className="text-sm text-muted-foreground">
              Work that couldn&apos;t be scheduled, with a reason.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href="/unassigned-visits" />}
          >
            Review
          </Button>
        </div>
      )}
    </div>
  );
}
