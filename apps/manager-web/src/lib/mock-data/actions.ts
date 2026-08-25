/**
 * Simulates the ULK-C02 endpoint for editing an employee's vehicle
 * authorizations. Always succeeds today — there is nothing real to persist
 * to until ULK-C02 publishes the endpoint — but it's a real async function
 * returning a real Promise, so the UI's confirm/success/error handling
 * exercises the exact path it will use once the real endpoint exists.
 * Tests mock this function's rejection to exercise the error path.
 */
export async function submitVehicleAuthorizations(
  employeeId: string,
  vehicleIds: string[]
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  void employeeId;
  void vehicleIds;
}
