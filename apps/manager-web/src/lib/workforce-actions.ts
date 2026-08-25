import {
  authorizeVehicle,
  revokeVehicleAuthorization,
  fetchEmployee,
  type Employee,
} from "./api-client";

/**
 * Saves an employee's complete set of driving authorizations.
 *
 * The API grants and withdraws one at a time — deliberately, because each is
 * an audited event with its own before/after record. This works out the
 * difference and issues only the calls that changed, so re-saving an unchanged
 * form writes nothing to the audit trail.
 *
 * Not a transaction: if a later call fails, earlier ones stand. The employee
 * is re-read afterwards so the screen shows what the server actually holds
 * rather than what was optimistically hoped for.
 */
export async function submitVehicleAuthorizations(
  employeeId: string,
  currentVehicleIds: string[],
  nextVehicleIds: string[]
): Promise<Employee> {
  const current = new Set(currentVehicleIds);
  const next = new Set(nextVehicleIds);

  const toGrant = nextVehicleIds.filter((id) => !current.has(id));
  const toRevoke = currentVehicleIds.filter((id) => !next.has(id));

  for (const vehicleId of toGrant) {
    await authorizeVehicle(employeeId, vehicleId);
  }
  for (const vehicleId of toRevoke) {
    await revokeVehicleAuthorization(employeeId, vehicleId);
  }

  return fetchEmployee(employeeId);
}
