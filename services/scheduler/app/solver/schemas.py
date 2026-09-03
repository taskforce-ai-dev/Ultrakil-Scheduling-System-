"""Wire format for a solve request.

Deliberately dumb data: the service is handed everything it needs and owns no
database. That keeps the solver reproducible — the same request always yields
the same schedule — and means the API stays the only thing that can write.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

LockScope = Literal["FULL", "CREW", "VEHICLE", "TIME"]


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
    """Every legal date and time this visit could take, when the caller is
    willing to let the solver move it.

    Left empty the visit is pinned exactly where it is — which is what a
    published or time-locked visit sends, and what keeps a caller that knows
    nothing about slots behaving as it always did. Given candidates, the visit
    lands on whichever one produces the best schedule overall, and the date it
    was generated on carries no weight of its own."""
    candidate_slots: list[CandidateSlot] = Field(default_factory=list)


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
    """Dates (YYYY-MM-DD) this person cannot work: leave, sickness, training."""
    unavailable_dates: list[str] = Field(default_factory=list)


class VehicleInput(BaseModel):
    id: str
    """Null when the workforce matrix never recorded a branch. Unknown is not
    wrong, so an unbranded vehicle is usable anywhere."""
    branch_code: str | None = None
    seat_capacity: int | None = None


class LockInput(BaseModel):
    """A manager's decision the solver must not overturn."""

    visit_id: str
    scope: LockScope
    employee_ids: list[str] = Field(default_factory=list)
    vehicle_ids: list[str] = Field(default_factory=list)
    start_minute: int | None = None


class ExistingAssignmentInput(BaseModel):
    """What is already proposed, so a rerun can avoid churning the board."""

    visit_id: str
    employee_ids: list[str] = Field(default_factory=list)
    vehicle_ids: list[str] = Field(default_factory=list)


class SolveRequest(BaseModel):
    run_id: str
    visits: list[VisitInput]
    employees: list[EmployeeInput]
    vehicles: list[VehicleInput] = Field(default_factory=list)
    locks: list[LockInput] = Field(default_factory=list)
    existing: list[ExistingAssignmentInput] = Field(default_factory=list)
    time_limit_seconds: float = Field(default=20.0, ge=0.5, le=300.0)
    """Fixed seed and a single worker keep the same request reproducible.
    Managers rerun a schedule and compare; a different answer each time from
    identical inputs would make that comparison worthless."""
    random_seed: int = 0


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


class SolveResponse(BaseModel):
    run_id: str
    status: Literal["OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNKNOWN"]
    assignments: list[AssignmentOutput]
    unassigned: list[UnassignedOutput]
    solve_seconds: float
    objective_value: int
    visits_considered: int
