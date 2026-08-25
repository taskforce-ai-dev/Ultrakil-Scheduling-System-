import { EmptyState } from "@/components/shared/empty-state";
import { mockEmployees } from "@/lib/mock-data";
import { EmployeeDetailView } from "./employee-detail-view";

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const { employeeId } = await params;
  const employee = mockEmployees.find((candidate) => candidate.id === employeeId);

  if (!employee) {
    return (
      <EmptyState
        title="Employee not found"
        description={`No employee matches ID "${employeeId}". It may have been removed.`}
      />
    );
  }

  return <EmployeeDetailView employee={employee} />;
}
