import { BranchCode } from '@prisma/client';

import { DEMO_MARKER, buildDemoMatrix } from './demo-data';
import { isPmsGradeLabel } from '../src/workforce/pms-grade';

/**
 * The demo workforce exists so the portal has something real-shaped to render.
 * These tests pin the properties that make it useful — if someone trims the
 * data down and quietly removes, say, the only Kandy supervisor, the frontend
 * silently loses the one case it needs to demonstrate.
 */
describe('demo workforce', () => {
  const matrix = buildDemoMatrix();

  it('staffs both branches, so branch isolation is visible', () => {
    const branches = new Set(matrix.employees.map((e) => e.branchCode));

    expect(branches).toContain(BranchCode.COLOMBO);
    expect(branches).toContain(BranchCode.KANDY);
  });

  it('gives every branch a PMS-grade supervisor, so every branch is schedulable', () => {
    // The real matrix has no Kandy supervisor. That is a live data question for
    // UltraKIL; the demo set must not inherit it, or nobody can see a working
    // Kandy job while it is open.
    for (const branchCode of Object.values(BranchCode)) {
      const supervisors = matrix.employees.filter(
        (employee) => employee.branchCode === branchCode && employee.isPmsGrade,
      );

      expect(supervisors.length).toBeGreaterThan(0);
    }
  });

  it('derives isPmsGrade from the grade label rather than hard-coding it', () => {
    for (const employee of matrix.employees) {
      expect(employee.isPmsGrade).toBe(isPmsGradeLabel(employee.gradeLabel));
    }
  });

  it('excludes Pest Management Executive from the supervisor grades', () => {
    const executive = matrix.employees.find(
      (employee) => employee.gradeLabel === 'Pest Management Executive',
    );

    expect(executive).toBeDefined();
    expect(executive?.isPmsGrade).toBe(false);
  });

  it('includes permanently stationed staff, who must never be moved', () => {
    const stationed = matrix.employees.filter((e) => e.isPermanentlyStationed);

    expect(stationed.length).toBeGreaterThan(0);
    for (const employee of stationed) {
      expect(employee.permanentSiteName).toBeTruthy();
    }
  });

  it('includes someone who can only reach a site by public transport', () => {
    expect(matrix.employees.some((e) => e.canUsePublicTransport)).toBe(true);
  });

  it('authorises every referenced vehicle, so no authorization dangles', () => {
    const known = new Set(matrix.vehicles.map((vehicle) => vehicle.code));

    for (const employee of matrix.employees) {
      for (const reference of employee.vehicles) {
        expect(known).toContain(reference.vehicleCode);
      }
    }
  });

  it('shares a vehicle between drivers and gives one driver several vehicles', () => {
    const driversPerVehicle = new Map<string, number>();
    for (const employee of matrix.employees) {
      for (const reference of employee.vehicles) {
        driversPerVehicle.set(
          reference.vehicleCode,
          (driversPerVehicle.get(reference.vehicleCode) ?? 0) + 1,
        );
      }
    }

    expect([...driversPerVehicle.values()].some((count) => count > 1)).toBe(true);
    expect(matrix.employees.some((e) => e.vehicles.length > 1)).toBe(true);
  });

  it('gives every employee a unique source key, so the import stays idempotent', () => {
    const keys = matrix.employees.map((employee) => employee.sourceKey);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('marks every row as fabricated, so the seed can tell demo from real', () => {
    for (const employee of matrix.employees) {
      expect(employee.sourceRow[DEMO_MARKER]).toBe('true');
    }
  });

  it('parses a registration out of every vehicle header', () => {
    for (const vehicle of matrix.vehicles) {
      expect(vehicle.code).toMatch(/\d/);
      expect(vehicle.label).toContain(vehicle.code);
    }
  });
});
