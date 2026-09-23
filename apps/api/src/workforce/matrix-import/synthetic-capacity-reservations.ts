export const SYNTHETIC_CAPACITY_MARKER = '__syntheticCapacity__';
export const SYNTHETIC_VEHICLE_PREFIX = 'SYN-TEST-';
export const SYNTHETIC_VISIBLE_PREFIX = 'SYNTHETIC/TEST ';

export function assertNoReservedSyntheticVehicles(
  vehicles: Array<{ code: string; label: string; ownershipGroup: string | null }>,
): void {
  if (vehicles.some((vehicle) =>
    vehicle.code.startsWith(SYNTHETIC_VEHICLE_PREFIX) ||
    vehicle.label.startsWith(SYNTHETIC_VISIBLE_PREFIX) ||
    vehicle.ownershipGroup === SYNTHETIC_CAPACITY_MARKER,
  )) {
    throw new Error('MATRIX_RESERVED_SYNTHETIC_VEHICLE_IDENTITY');
  }
}
