import { Prisma } from '@prisma/client';
import {
  AuthorizedVehicleDto,
  AvailabilityDto,
  EmployeeDto,
  VehicleDto,
} from './dto/responses.dto';

/** The shape EmployeesService loads. Keeps the mapper honest about its input. */
export type EmployeeWithRelations = Prisma.EmployeeGetPayload<{
  include: {
    branch: { select: { id: true; code: true; name: true } };
    skills: true;
    availability: true;
    vehicleAuthorizations: {
      include: {
        vehicle: {
          select: {
            id: true;
            code: true;
            label: true;
            seatCapacity: true;
            isActive: true;
          };
        };
      };
    };
  };
}>;

export type VehicleWithCounts = Prisma.VehicleGetPayload<{
  include: {
    branch: { select: { id: true; code: true; name: true } };
    _count: { select: { authorizations: true } };
  };
}>;

/** Dates cross the wire as plain YYYY-MM-DD, matching how they are stored. */
function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function toEmployeeDto(employee: EmployeeWithRelations): EmployeeDto {
  const authorizedVehicles: AuthorizedVehicleDto[] = employee.vehicleAuthorizations
    .map((authorization) => ({
      id: authorization.vehicle.id,
      code: authorization.vehicle.code,
      label: authorization.vehicle.label,
      seatCapacity: authorization.vehicle.seatCapacity,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const availability: AvailabilityDto[] = employee.availability.map((period) => ({
    id: period.id,
    startDate: toDateOnly(period.startDate),
    endDate: toDateOnly(period.endDate),
    kind: period.kind,
    reason: period.reason,
  }));

  return {
    id: employee.id,
    employeeCode: employee.employeeCode,
    fullName: employee.fullName,
    gradeLabel: employee.gradeLabel,
    isPmsGrade: employee.isPmsGrade,
    branchCode: employee.branchCode,
    branch: employee.branch,
    deploymentType: employee.deploymentType,
    permanentSiteLabel: employee.permanentSiteLabel,
    canUsePublicTransport: employee.canUsePublicTransport,
    isActive: employee.isActive,
    skills: employee.skills.map((skill) => ({
      skillCode: skill.skillCode,
      skillLabel: skill.skillLabel,
    })),
    authorizedVehicles,
    authorizedVehicleIds: authorizedVehicles.map((vehicle) => vehicle.id),
    availability,
    createdAt: employee.createdAt.toISOString(),
    updatedAt: employee.updatedAt.toISOString(),
    // sourceKey and sourceRow are deliberately absent: import bookkeeping and a
    // copy of the whole workbook line, of no use to a client.
  };
}

export function toVehicleDto(vehicle: VehicleWithCounts): VehicleDto {
  return {
    id: vehicle.id,
    code: vehicle.code,
    label: vehicle.label,
    seatCapacity: vehicle.seatCapacity,
    branchCode: vehicle.branch?.code ?? null,
    isActive: vehicle.isActive,
    authorizedDriverCount: vehicle._count.authorizations,
    createdAt: vehicle.createdAt.toISOString(),
    updatedAt: vehicle.updatedAt.toISOString(),
  };
}
