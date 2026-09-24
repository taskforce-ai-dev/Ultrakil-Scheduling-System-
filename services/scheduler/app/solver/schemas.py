"""Wire format for a solve request.

Deliberately dumb data: the service is handed everything it needs and owns no
database. That keeps the solver reproducible — the same request always yields
the same schedule — and means the API stays the only thing that can write.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

LockScope = Literal["FULL", "CREW", "SUPERVISOR", "VEHICLE", "TIME"]


class OccupiedStartKey(BaseModel):
    """A generated-visit unique key already owned by a sibling visit.

    The API supplies every sibling key, including unassigned and otherwise
    omitted visits.  A move may not overwrite one merely because that sibling
    did not need a crew in this solve.
    """

    date: str
    start_minute: int


class VisitInput(BaseModel):
    id: str
    branch_code: str
    """YYYY-MM-DD. Visits on different dates can never clash."""
    visit_date: str
    window_start_minute: int
    window_end_minute: int
    duration_minutes: int
    required_crew_size: int
    required_skill_codes: list[str] = Field(default_factory=list)
    service_site_id: str
    """Which commitment this visit satisfies. Two visits of the same agreement
    are the same job at the same site, so they never share a day."""
    service_agreement_id: str = ""
    """Set by ULK-C04 when the date fell on a preferred weekday, not merely an
    allowed one. A soft preference: worth a nudge, never a refusal."""
    is_preferred_day: bool = False
    """Omitted/null means the legacy fixed-window fallback. An explicit []
    means the API found no legal date/time and the visit must be unassigned.
    Time locks override slots with the manager's exact start/end. Nonempty
    candidates let the solver choose a legal date and time."""
    candidate_slots: list[CandidateSlot] | None = None
    occupied_start_keys: list[OccupiedStartKey] = Field(default_factory=list)


class CandidateSlot(BaseModel):
    """One legal place a visit could go: a date, and the earliest and latest it
    could start on that date.

    The API works these out, because only it knows the agreement's allowed
    weekdays and the site's opening hours for each of them. The solver's job is
    to choose between them — which is the whole point of ULK-C09's successor
    change: date, time, crew and vehicle decided together instead of the date
    being fixed first and the crew squeezed in around it.
    """

    date: str
    earliest_start_minute: int
    latest_start_minute: int
    """True when this date falls on a weekday the customer prefers rather than
    merely allows. A soft preference, scored, never enforced."""
    is_preferred: bool = False


class EmployeeInput(BaseModel):
    id: str
    branch_code: str
    is_pms_grade: bool = False
    is_permanently_stationed: bool = False
    permanent_site_ids: list[str] = Field(default_factory=list)
    skill_codes: list[str] = Field(default_factory=list)
    authorized_vehicle_ids: list[str] = Field(default_factory=list)
    """Check-marked for public transport in the workforce matrix: this person can
    reach a site without a company vehicle. Defaults false, so a solver given an
    older payload keeps everyone in a vehicle rather than stranding them."""
    can_use_public_transport: bool = False
    """Dates (YYYY-MM-DD) this person cannot work: leave, sickness, training."""
    unavailable_dates: list[str] = Field(default_factory=list)


class VehicleInput(BaseModel):
    id: str
    """Null when the workforce matrix never recorded a branch. Unknown is not
    wrong, so an unbranded vehicle is usable anywhere."""
    branch_code: str | None = None
    seat_capacity: int | None = None


class LockedVehicleDriver(BaseModel):
    vehicle_id: str
    driver_employee_id: str | None


class LockInput(BaseModel):
    """A manager's decision the solver must not overturn."""

    visit_id: str
    scope: LockScope
    employee_ids: list[str] = Field(default_factory=list)
    vehicle_ids: list[str] = Field(default_factory=list)
    vehicle_drivers: list[LockedVehicleDriver] = Field(default_factory=list)
    start_minute: int | None = None
    end_minute: int | None = None

    @model_validator(mode="after")
    def validate_drivers(self) -> LockInput:
        ids = [entry.vehicle_id for entry in self.vehicle_drivers]
        if len(ids) != len(set(ids)) or any(
            vehicle_id not in self.vehicle_ids for vehicle_id in ids
        ):
            raise ValueError("vehicle lock drivers must map each locked vehicle at most once")
        if self.scope == "SUPERVISOR" and not self.employee_ids:
            raise ValueError("supervisor lock requires a supervisor identity")
        return self


class ExistingAssignmentInput(BaseModel):
    """What is already proposed, so a rerun can avoid churning the board."""

    visit_id: str
    employee_ids: list[str] = Field(default_factory=list)
    vehicle_ids: list[str] = Field(default_factory=list)
    start_minute: int | None = None
    """Previous minute-of-day. A soft preference only, never a time lock."""


class ReservationInput(BaseModel):
    """Resources fixed by a published assignment outside this solve."""

    assignment_id: str | None = None
    scheduled_date: str
    start_minute: int
    end_minute: int
    employee_ids: list[str] = Field(default_factory=list)
    vehicle_ids: list[str] = Field(default_factory=list)


class SolveRequest(BaseModel):
    run_id: str
    visits: list[VisitInput]
    employees: list[EmployeeInput]
    vehicles: list[VehicleInput] = Field(default_factory=list)
    locks: list[LockInput] = Field(default_factory=list)
    existing: list[ExistingAssignmentInput] = Field(default_factory=list)
    reservations: list[ReservationInput] = Field(default_factory=list)
    """Published work held fixed while draft work is re-solved."""
    excluded_reservation_assignment_ids: list[str] = Field(default_factory=list)
    """Repair callers may omit only the exact predecessor they supersede."""
    time_limit_seconds: float = Field(default=20.0, ge=0.5, le=300.0)
    """Fixed seed and a single worker keep the same request reproducible.
    Managers rerun a schedule and compare; a different answer each time from
    identical inputs would make that comparison worthless."""
    random_seed: int = 0

    @model_validator(mode="after")
    def validate_locks(self) -> SolveRequest:
        by_visit: dict[str, dict[LockScope, LockInput]] = {}
        for lock in self.locks:
            scopes = by_visit.setdefault(lock.visit_id, {})
            if lock.scope in scopes:
                raise ValueError(f"duplicate lock scope for visit {lock.visit_id}: {lock.scope}")
            scopes[lock.scope] = lock
        for visit_id, scopes in by_visit.items():
            full = scopes.get("FULL")
            supervisor = scopes.get("SUPERVISOR")
            crew = scopes.get("CREW")
            if supervisor and crew and not set(supervisor.employee_ids) <= set(crew.employee_ids):
                raise ValueError(f"conflicting supervisor and crew locks for visit {visit_id}")
            if full is None:
                continue
            time_lock = scopes.get("TIME")
            if time_lock and (
                full.start_minute != time_lock.start_minute
                or full.end_minute != time_lock.end_minute
            ):
                raise ValueError(f"conflicting time locks for visit {visit_id}")
            if crew and set(full.employee_ids) != set(crew.employee_ids):
                raise ValueError(f"conflicting crew locks for visit {visit_id}")
            if supervisor and not set(supervisor.employee_ids) <= set(full.employee_ids):
                raise ValueError(f"conflicting supervisor and full locks for visit {visit_id}")
            vehicle_lock = scopes.get("VEHICLE")
            if vehicle_lock and (
                set(full.vehicle_ids) != set(vehicle_lock.vehicle_ids)
                or {row.vehicle_id: row.driver_employee_id for row in full.vehicle_drivers}
                != {row.vehicle_id: row.driver_employee_id for row in vehicle_lock.vehicle_drivers}
            ):
                raise ValueError(f"conflicting vehicle locks for visit {visit_id}")
        return self


class VehicleAssignmentOutput(BaseModel):
    vehicle_id: str
    driver_employee_id: str


class AssignmentOutput(BaseModel):
    visit_id: str
    employee_ids: list[str]
    vehicles: list[VehicleAssignmentOutput] = Field(default_factory=list)
    start_minute: int
    """The date the solver settled on. Equal to the visit's own date when it was
    pinned; possibly a different allowed weekday when it was free to move."""
    scheduled_date: str


class UnassignedOutput(BaseModel):
    visit_id: str
    """Stable codes from the shared catalogue, so the Unassigned queue reads the
    same whether a human or the solver could not staff the work."""
    reason_codes: list[str]
    message: str
    """The same sentences keyed by their code.

    `message` joins them all, which is right for a one-line summary and wrong
    for anything else: written against each code in turn it made the queue
    claim an employee clash was a service-hours problem. Callers that show a
    reason on its own read this instead."""
    reason_messages: dict[str, str] = Field(default_factory=dict)


class SolveResponse(BaseModel):
    run_id: str
    status: Literal["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"]
    assignments: list[AssignmentOutput]
    unassigned: list[UnassignedOutput]
    solve_seconds: float
    objective_value: int
    visits_considered: int
