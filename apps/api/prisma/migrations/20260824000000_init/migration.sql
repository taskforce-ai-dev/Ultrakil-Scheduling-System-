-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "BranchCode" AS ENUM ('COLOMBO', 'KANDY');

-- CreateEnum
CREATE TYPE "Weekday" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "DeploymentType" AS ENUM ('MOBILE', 'PERMANENTLY_STATIONED');

-- CreateEnum
CREATE TYPE "FrequencyUnit" AS ENUM ('WEEK', 'MONTH');

-- CreateEnum
CREATE TYPE "DayRuleKind" AS ENUM ('ALLOWED', 'PREFERRED');

-- CreateEnum
CREATE TYPE "VisitStatus" AS ENUM ('PENDING', 'SCHEDULED', 'UNASSIGNED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('DRAFT', 'PROPOSED', 'PUBLISHED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CrewRole" AS ENUM ('SUPERVISOR', 'TECHNICIAN', 'DRIVER', 'HELPER');

-- CreateEnum
CREATE TYPE "LockScope" AS ENUM ('FULL', 'CREW', 'VEHICLE', 'TIME');

-- CreateEnum
CREATE TYPE "ScheduleRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScheduleRunTrigger" AS ENUM ('MANUAL', 'AGREEMENT_CHANGE', 'SCHEDULED_JOB', 'MANAGER_OVERRIDE');

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "code" "BranchCode" NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "employeeCode" TEXT,
    "fullName" TEXT NOT NULL,
    "gradeLabel" TEXT NOT NULL,
    "isPmsGrade" BOOLEAN NOT NULL DEFAULT false,
    "branchId" UUID NOT NULL,
    "branchCode" "BranchCode" NOT NULL,
    "deploymentType" "DeploymentType" NOT NULL DEFAULT 'MOBILE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceRow" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_skills" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "skillCode" TEXT NOT NULL,
    "skillLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permanent_assignments" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "serviceSiteId" UUID NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permanent_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "branchId" UUID,
    "seatCapacity" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_authorizations" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "customerCode" TEXT,
    "branchId" UUID NOT NULL,
    "branchCode" "BranchCode" NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_sites" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine" TEXT,
    "city" TEXT,
    "branchId" UUID NOT NULL,
    "branchCode" "BranchCode" NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_operating_hours" (
    "id" UUID NOT NULL,
    "serviceSiteId" UUID NOT NULL,
    "weekday" "Weekday" NOT NULL,
    "opensAtMinute" INTEGER NOT NULL,
    "closesAtMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_operating_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultDurationMinutes" INTEGER NOT NULL DEFAULT 60,
    "defaultCrewSize" INTEGER NOT NULL DEFAULT 2,
    "requiresPmsSupervisor" BOOLEAN NOT NULL DEFAULT true,
    "requiredSkillCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_agreements" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "serviceSiteId" UUID NOT NULL,
    "jobTypeId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "branchCode" "BranchCode" NOT NULL,
    "frequencyCount" INTEGER NOT NULL,
    "frequencyUnit" "FrequencyUnit" NOT NULL,
    "crewSize" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "serviceWindowStartMinute" INTEGER,
    "serviceWindowEndMinute" INTEGER,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_agreement_day_rules" (
    "id" UUID NOT NULL,
    "serviceAgreementId" UUID NOT NULL,
    "weekday" "Weekday" NOT NULL,
    "kind" "DayRuleKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_agreement_day_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_visits" (
    "id" UUID NOT NULL,
    "serviceAgreementId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "branchCode" "BranchCode" NOT NULL,
    "visitDate" DATE NOT NULL,
    "windowStartMinute" INTEGER NOT NULL,
    "windowEndMinute" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "requiredCrewSize" INTEGER NOT NULL,
    "status" "VisitStatus" NOT NULL DEFAULT 'PENDING',
    "generatedByRunId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generated_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visit_unassigned_reasons" (
    "id" UUID NOT NULL,
    "generatedVisitId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "scheduleRunId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visit_unassigned_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" UUID NOT NULL,
    "generatedVisitId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "branchCode" "BranchCode" NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'DRAFT',
    "plannedStart" TIMESTAMP(3) NOT NULL,
    "plannedEnd" TIMESTAMP(3) NOT NULL,
    "scheduleRunId" UUID,
    "publishedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_crew_members" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "role" "CrewRole" NOT NULL DEFAULT 'TECHNICIAN',
    "isPmsSupervisor" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_crew_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_vehicles" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "driverEmployeeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_locks" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "scope" "LockScope" NOT NULL DEFAULT 'FULL',
    "lockedByUserId" TEXT,
    "reason" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_runs" (
    "id" UUID NOT NULL,
    "status" "ScheduleRunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "ScheduleRunTrigger" NOT NULL DEFAULT 'MANUAL',
    "branchCode" "BranchCode",
    "rangeStart" DATE NOT NULL,
    "rangeEnd" DATE NOT NULL,
    "requestedByUserId" TEXT,
    "visitsConsidered" INTEGER NOT NULL DEFAULT 0,
    "visitsScheduled" INTEGER NOT NULL DEFAULT 0,
    "visitsUnassigned" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorLabel" TEXT,
    "before" JSONB,
    "after" JSONB,
    "scheduleRunId" UUID,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "branches_code_key" ON "branches"("code");

-- CreateIndex
CREATE UNIQUE INDEX "employees_sourceKey_key" ON "employees"("sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employeeCode_key" ON "employees"("employeeCode");

-- CreateIndex
CREATE INDEX "employees_branchId_isActive_idx" ON "employees"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "employees_isPmsGrade_branchCode_idx" ON "employees"("isPmsGrade", "branchCode");

-- CreateIndex
CREATE INDEX "employee_skills_skillCode_idx" ON "employee_skills"("skillCode");

-- CreateIndex
CREATE UNIQUE INDEX "employee_skills_employeeId_skillCode_key" ON "employee_skills"("employeeId", "skillCode");

-- CreateIndex
CREATE INDEX "permanent_assignments_serviceSiteId_idx" ON "permanent_assignments"("serviceSiteId");

-- CreateIndex
CREATE UNIQUE INDEX "permanent_assignments_employeeId_serviceSiteId_effectiveFro_key" ON "permanent_assignments"("employeeId", "serviceSiteId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_code_key" ON "vehicles"("code");

-- CreateIndex
CREATE INDEX "vehicle_authorizations_vehicleId_idx" ON "vehicle_authorizations"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_authorizations_employeeId_vehicleId_key" ON "vehicle_authorizations"("employeeId", "vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_customerCode_key" ON "customers"("customerCode");

-- CreateIndex
CREATE INDEX "customers_branchId_isActive_idx" ON "customers"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "service_sites_customerId_idx" ON "service_sites"("customerId");

-- CreateIndex
CREATE INDEX "service_sites_branchId_isActive_idx" ON "service_sites"("branchId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "site_operating_hours_serviceSiteId_weekday_key" ON "site_operating_hours"("serviceSiteId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "job_types_code_key" ON "job_types"("code");

-- CreateIndex
CREATE INDEX "service_agreements_customerId_idx" ON "service_agreements"("customerId");

-- CreateIndex
CREATE INDEX "service_agreements_serviceSiteId_idx" ON "service_agreements"("serviceSiteId");

-- CreateIndex
CREATE INDEX "service_agreements_branchId_isActive_idx" ON "service_agreements"("branchId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "service_agreement_day_rules_serviceAgreementId_weekday_kind_key" ON "service_agreement_day_rules"("serviceAgreementId", "weekday", "kind");

-- CreateIndex
CREATE INDEX "generated_visits_branchId_visitDate_status_idx" ON "generated_visits"("branchId", "visitDate", "status");

-- CreateIndex
CREATE INDEX "generated_visits_status_idx" ON "generated_visits"("status");

-- CreateIndex
CREATE UNIQUE INDEX "generated_visits_serviceAgreementId_visitDate_windowStartMi_key" ON "generated_visits"("serviceAgreementId", "visitDate", "windowStartMinute");

-- CreateIndex
CREATE INDEX "visit_unassigned_reasons_generatedVisitId_idx" ON "visit_unassigned_reasons"("generatedVisitId");

-- CreateIndex
CREATE INDEX "visit_unassigned_reasons_code_idx" ON "visit_unassigned_reasons"("code");

-- CreateIndex
CREATE INDEX "assignments_branchId_status_idx" ON "assignments"("branchId", "status");

-- CreateIndex
CREATE INDEX "assignments_generatedVisitId_idx" ON "assignments"("generatedVisitId");

-- CreateIndex
CREATE INDEX "assignments_plannedStart_idx" ON "assignments"("plannedStart");

-- CreateIndex
CREATE INDEX "assignment_crew_members_employeeId_idx" ON "assignment_crew_members"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_crew_members_assignmentId_employeeId_key" ON "assignment_crew_members"("assignmentId", "employeeId");

-- CreateIndex
CREATE INDEX "assignment_vehicles_vehicleId_idx" ON "assignment_vehicles"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_vehicles_assignmentId_vehicleId_key" ON "assignment_vehicles"("assignmentId", "vehicleId");

-- CreateIndex
CREATE INDEX "assignment_locks_assignmentId_idx" ON "assignment_locks"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_locks_assignmentId_scope_key" ON "assignment_locks"("assignmentId", "scope");

-- CreateIndex
CREATE INDEX "schedule_runs_status_createdAt_idx" ON "schedule_runs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_entityType_entityId_createdAt_idx" ON "audit_events"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_action_createdAt_idx" ON "audit_events"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permanent_assignments" ADD CONSTRAINT "permanent_assignments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permanent_assignments" ADD CONSTRAINT "permanent_assignments_serviceSiteId_fkey" FOREIGN KEY ("serviceSiteId") REFERENCES "service_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_authorizations" ADD CONSTRAINT "vehicle_authorizations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_authorizations" ADD CONSTRAINT "vehicle_authorizations_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_sites" ADD CONSTRAINT "service_sites_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_sites" ADD CONSTRAINT "service_sites_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_operating_hours" ADD CONSTRAINT "site_operating_hours_serviceSiteId_fkey" FOREIGN KEY ("serviceSiteId") REFERENCES "service_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreements" ADD CONSTRAINT "service_agreements_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreements" ADD CONSTRAINT "service_agreements_serviceSiteId_fkey" FOREIGN KEY ("serviceSiteId") REFERENCES "service_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreements" ADD CONSTRAINT "service_agreements_jobTypeId_fkey" FOREIGN KEY ("jobTypeId") REFERENCES "job_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreements" ADD CONSTRAINT "service_agreements_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement_day_rules" ADD CONSTRAINT "service_agreement_day_rules_serviceAgreementId_fkey" FOREIGN KEY ("serviceAgreementId") REFERENCES "service_agreements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_visits" ADD CONSTRAINT "generated_visits_serviceAgreementId_fkey" FOREIGN KEY ("serviceAgreementId") REFERENCES "service_agreements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_visits" ADD CONSTRAINT "generated_visits_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_visits" ADD CONSTRAINT "generated_visits_generatedByRunId_fkey" FOREIGN KEY ("generatedByRunId") REFERENCES "schedule_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_unassigned_reasons" ADD CONSTRAINT "visit_unassigned_reasons_generatedVisitId_fkey" FOREIGN KEY ("generatedVisitId") REFERENCES "generated_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_unassigned_reasons" ADD CONSTRAINT "visit_unassigned_reasons_scheduleRunId_fkey" FOREIGN KEY ("scheduleRunId") REFERENCES "schedule_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_generatedVisitId_fkey" FOREIGN KEY ("generatedVisitId") REFERENCES "generated_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_scheduleRunId_fkey" FOREIGN KEY ("scheduleRunId") REFERENCES "schedule_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_crew_members" ADD CONSTRAINT "assignment_crew_members_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_crew_members" ADD CONSTRAINT "assignment_crew_members_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_vehicles" ADD CONSTRAINT "assignment_vehicles_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_vehicles" ADD CONSTRAINT "assignment_vehicles_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_vehicles" ADD CONSTRAINT "assignment_vehicles_driverEmployeeId_fkey" FOREIGN KEY ("driverEmployeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_locks" ADD CONSTRAINT "assignment_locks_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_scheduleRunId_fkey" FOREIGN KEY ("scheduleRunId") REFERENCES "schedule_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

