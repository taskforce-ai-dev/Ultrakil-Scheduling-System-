import { normalizeHeader, normalizeVehicleIdentity } from './mapping';

export const SYNTHETIC_CAPACITY_MARKER = '__syntheticCapacity__';
export const SYNTHETIC_VEHICLE_PREFIX = 'SYN-TEST-';
export const SYNTHETIC_VISIBLE_PREFIX = 'SYNTHETIC/TEST ';

export function assertNoReservedSyntheticVehicles(
  vehicles: Array<{ code: string; label: string; ownershipGroup: string | null }>,
): void {
  const reservedCodePrefix = normalizeVehicleIdentity(SYNTHETIC_VEHICLE_PREFIX);
  const reservedLabelPrefix = normalizeHeader(SYNTHETIC_VISIBLE_PREFIX);
  const reservedOwnership = normalizeVehicleIdentity(SYNTHETIC_CAPACITY_MARKER);
  if (vehicles.some((vehicle) =>
    normalizeVehicleIdentity(vehicle.code).startsWith(reservedCodePrefix) ||
    normalizeHeader(vehicle.label).startsWith(reservedLabelPrefix) ||
    (vehicle.ownershipGroup !== null &&
      normalizeVehicleIdentity(vehicle.ownershipGroup) === reservedOwnership),
  )) {
    throw new Error('MATRIX_RESERVED_SYNTHETIC_VEHICLE_IDENTITY');
  }
}
