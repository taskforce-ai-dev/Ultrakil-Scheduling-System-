"""The constraint model.

Two ideas run through this file.

**A hard rule is never traded away.** Every rule from ULK-C05 is a CP-SAT
constraint, not a penalty. The solver cannot buy its way out of one by
improving the objective, because there is no price on it. When a visit cannot
satisfy them all it comes back unassigned with reasons — a fuller schedule that
sends a crew somewhere they are not allowed to be is worse than an honest gap.

**Soft preferences only ever break ties.** Preferred weekdays, balanced
workloads and leaving an existing proposal alone are worth points. Staffing a
visit at all is worth far more than all of them together, so the solver will
never drop a visit to make the remaining ones tidier.
"""

from __future__ import annotations

import time
from collections import defaultdict

from ortools.sat.python import cp_model

from app.solver.schemas import (
    AssignmentOutput,
    SolveRequest,
    SolveResponse,
    UnassignedOutput,
    VehicleAssignmentOutput,
)

# Staffing a visit dominates every preference put together. The gap is wide on
# purpose: no combination of tidiness is worth leaving a customer unvisited.
WEIGHT_VISIT_STAFFED = 10_000
WEIGHT_PREFERRED_DAY = 30
WEIGHT_KEEP_EXISTING_CREW = 20
WEIGHT_KEEP_EXISTING_VEHICLE = 10
WEIGHT_WORKLOAD_SPREAD = 5
# A crew that can take a van should. Without a reward the solver has no reason
# to assign one at all, since a vehicle is optional — and a pest control crew
# arriving without their equipment is not a schedule anybody wanted.
WEIGHT_VEHICLE_ASSIGNED = 40


def _overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    """Touching is not overlapping: finishing at 12:00 frees the crew at 12:00."""
    return a_start < b_end and b_start < a_end


def _why_unstaffable(request: SolveRequest, visit) -> list[str]:
    """Reasons a visit could never be staffed, whatever the solver chose.

    Computed independently of the solve so the answer is the same whether the
    model proved it infeasible or simply ran out of better options. Uses the
    shared conflict codes, so the Unassigned queue reads identically whether a
    person or the solver failed to staff the work.
    """
    reasons: list[str] = []
    eligible = [e for e in request.employees if _employee_can_serve(e, visit)]

    if not any(e.is_pms_grade for e in eligible):
        in_branch = [e for e in request.employees if e.branch_code == visit.branch_code]
        if not any(e.is_pms_grade for e in in_branch):
            reasons.append("BRANCH_HAS_NO_PMS_SUPERVISOR")
        else:
            reasons.append("NO_PMS_SUPERVISOR_AVAILABLE")

    if len(eligible) < visit.required_crew_size:
        reasons.append("CREW_TOO_SMALL")

    held = {code for e in eligible for code in e.skill_codes}
    if any(code not in held for code in visit.required_skill_codes):
        reasons.append("SKILL_NOT_HELD")

    if visit.window_end_minute - visit.window_start_minute < visit.duration_minutes:
        reasons.append("WINDOW_TOO_SHORT")

    return reasons


def _employee_can_serve(employee, visit) -> bool:
    """The hard rules that depend on nothing but this one pairing."""
    if employee.branch_code != visit.branch_code:
        return False
    if visit.visit_date in employee.unavailable_dates:
        return False
    if employee.is_permanently_stationed:
        return visit.service_site_id in employee.permanent_site_ids
    return True


def solve(request: SolveRequest) -> SolveResponse:
    started = time.monotonic()
    model = cp_model.CpModel()

    # Sorted so the model is built identically however the API happened to
    # order the rows. Without this, two identical schedules could differ purely
    # because Postgres returned employees in another order — and a manager
    # rerunning to compare would see phantom changes.
    visits = sorted(request.visits, key=lambda v: v.id)
    employees = sorted(request.employees, key=lambda e: e.id)
    vehicles = sorted(request.vehicles, key=lambda k: k.id)

    locks_by_visit = {lock.visit_id: lock for lock in request.locks}
    existing_by_visit = {row.visit_id: row for row in request.existing}

    # --- Variables ----------------------------------------------------------
    #
    # staffed[v] lets a visit go unassigned rather than forcing the model
    # infeasible. One impossible visit must not cost the whole week.
    staffed = {v.id: model.NewBoolVar(f"staffed_{v.id}") for v in visits}
    assign: dict[tuple[str, str], cp_model.IntVar] = {}
    uses_vehicle: dict[tuple[str, str], cp_model.IntVar] = {}
    drives: dict[tuple[str, str, str], cp_model.IntVar] = {}

    for visit in visits:
        for employee in employees:
            if not _employee_can_serve(employee, visit):
                continue
            assign[visit.id, employee.id] = model.NewBoolVar(f"a_{visit.id}_{employee.id}")
        for vehicle in vehicles:
            # An unbranded vehicle is unknown, not wrong, so it stays usable.
            if vehicle.branch_code is not None and vehicle.branch_code != visit.branch_code:
                continue
            uses_vehicle[visit.id, vehicle.id] = model.NewBoolVar(f"v_{visit.id}_{vehicle.id}")

    # --- Hard rules ---------------------------------------------------------

    for visit in visits:
        crew = [assign[visit.id, e.id] for e in employees if (visit.id, e.id) in assign]

        # Exactly the crew size when staffed, nobody when not.
        model.Add(sum(crew) == visit.required_crew_size * staffed[visit.id]) if crew else model.Add(
            staffed[visit.id] == 0
        )

        if not crew:
            continue

        # At least one PMS-grade supervisor on every job.
        supervisors = [
            assign[visit.id, e.id]
            for e in employees
            if (visit.id, e.id) in assign and e.is_pms_grade
        ]
        if supervisors:
            model.Add(sum(supervisors) >= 1).OnlyEnforceIf(staffed[visit.id])
        else:
            model.Add(staffed[visit.id] == 0)

        # Every required skill covered by somebody going.
        for code in visit.required_skill_codes:
            holders = [
                assign[visit.id, e.id]
                for e in employees
                if (visit.id, e.id) in assign and code in e.skill_codes
            ]
            if holders:
                model.Add(sum(holders) >= 1).OnlyEnforceIf(staffed[visit.id])
            else:
                model.Add(staffed[visit.id] == 0)

        # The job has to fit in the window the customer allows.
        if visit.window_end_minute - visit.window_start_minute < visit.duration_minutes:
            model.Add(staffed[visit.id] == 0)

    # Nobody in two places at once. Only same-date, overlapping pairs can clash.
    by_date: dict[str, list] = defaultdict(list)
    for visit in visits:
        by_date[visit.visit_date].append(visit)

    for same_day in by_date.values():
        for i, first in enumerate(same_day):
            for second in same_day[i + 1 :]:
                if not _overlaps(
                    first.window_start_minute,
                    first.window_start_minute + first.duration_minutes,
                    second.window_start_minute,
                    second.window_start_minute + second.duration_minutes,
                ):
                    continue
                for employee in employees:
                    left = assign.get((first.id, employee.id))
                    right = assign.get((second.id, employee.id))
                    if left is not None and right is not None:
                        model.Add(left + right <= 1)
                for vehicle in vehicles:
                    left_v = uses_vehicle.get((first.id, vehicle.id))
                    right_v = uses_vehicle.get((second.id, vehicle.id))
                    if left_v is not None and right_v is not None:
                        model.Add(left_v + right_v <= 1)

    # Vehicles: seats, and a driver who is actually going and authorized.
    for visit in visits:
        for vehicle in vehicles:
            used = uses_vehicle.get((visit.id, vehicle.id))
            if used is None:
                continue

            over_capacity = (
                vehicle.seat_capacity is not None
                and visit.required_crew_size > vehicle.seat_capacity
            )
            if over_capacity:
                model.Add(used == 0)
                continue

            possible_drivers = [
                e
                for e in employees
                if (visit.id, e.id) in assign and vehicle.id in e.authorized_vehicle_ids
            ]
            if not possible_drivers:
                model.Add(used == 0)
                continue

            driver_vars = []
            for employee in possible_drivers:
                drive = model.NewBoolVar(f"d_{visit.id}_{vehicle.id}_{employee.id}")
                drives[visit.id, vehicle.id, employee.id] = drive
                # A driver must be on the crew, and only drives if the van is used.
                model.AddImplication(drive, assign[visit.id, employee.id])
                model.AddImplication(drive, used)
                driver_vars.append(drive)
            model.Add(sum(driver_vars) == used)

    # --- Manager locks ------------------------------------------------------
    #
    # A lock is a hard constraint, not a preference. It can never make an
    # invalid assignment valid, though: the rules above still apply, so a lock
    # on an impossible crew simply leaves the visit unassigned.
    for visit in visits:
        lock = locks_by_visit.get(visit.id)
        if lock is None:
            continue

        if lock.scope in ("FULL", "CREW"):
            for employee in employees:
                var = assign.get((visit.id, employee.id))
                if var is None:
                    continue
                model.Add(var == (1 if employee.id in lock.employee_ids else 0))
            if lock.employee_ids:
                model.Add(staffed[visit.id] == 1)

        if lock.scope in ("FULL", "VEHICLE"):
            for vehicle in vehicles:
                var = uses_vehicle.get((visit.id, vehicle.id))
                if var is None:
                    continue
                model.Add(var == (1 if vehicle.id in lock.vehicle_ids else 0))

    # --- Soft preferences ---------------------------------------------------

    terms: list[tuple[int, cp_model.IntVar]] = []

    for visit in visits:
        terms.append((WEIGHT_VISIT_STAFFED, staffed[visit.id]))
        if visit.is_preferred_day:
            terms.append((WEIGHT_PREFERRED_DAY, staffed[visit.id]))

        for vehicle in vehicles:
            used = uses_vehicle.get((visit.id, vehicle.id))
            if used is not None:
                terms.append((WEIGHT_VEHICLE_ASSIGNED, used))

        existing = existing_by_visit.get(visit.id)
        if existing:
            # Churn on the dispatch board costs a manager their bearings, so
            # keeping a person on a visit they were already proposed for is
            # worth something — but far less than staffing the visit at all.
            for employee_id in existing.employee_ids:
                var = assign.get((visit.id, employee_id))
                if var is not None:
                    terms.append((WEIGHT_KEEP_EXISTING_CREW, var))
            for vehicle_id in existing.vehicle_ids:
                var = uses_vehicle.get((visit.id, vehicle_id))
                if var is not None:
                    terms.append((WEIGHT_KEEP_EXISTING_VEHICLE, var))

    # Balanced utilisation, expressed as "flatten the busiest person". Without
    # it the solver happily gives one supervisor every job on a Wednesday.
    objective = sum(weight * var for weight, var in terms)
    if employees and visits:
        busiest = model.NewIntVar(0, len(visits), "busiest")
        for employee in employees:
            load = [assign[v.id, employee.id] for v in visits if (v.id, employee.id) in assign]
            if load:
                model.Add(busiest >= sum(load))
        objective = objective - WEIGHT_WORKLOAD_SPREAD * busiest

    model.Maximize(objective)

    # --- Solve --------------------------------------------------------------

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = request.time_limit_seconds
    solver.parameters.random_seed = request.random_seed
    # One worker, fixed seed: identical requests must give identical schedules,
    # because managers rerun and compare. Parallel search would not guarantee it.
    solver.parameters.num_search_workers = 1
    status = solver.Solve(model)

    status_name = {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
    }.get(status, "UNKNOWN")

    assignments: list[AssignmentOutput] = []
    unassigned: list[UnassignedOutput] = []

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for visit in visits:
            if not solver.Value(staffed[visit.id]):
                reasons = _why_unstaffable(request, visit) or ["NO_FEASIBLE_CREW"]
                unassigned.append(
                    UnassignedOutput(
                        visit_id=visit.id,
                        reason_codes=reasons,
                        message=_message_for(reasons),
                    )
                )
                continue

            crew = sorted(
                e.id
                for e in employees
                if (visit.id, e.id) in assign and solver.Value(assign[visit.id, e.id])
            )
            chosen_vehicles = []
            for vehicle in vehicles:
                used = uses_vehicle.get((visit.id, vehicle.id))
                if used is None or not solver.Value(used):
                    continue
                driver = next(
                    (
                        employee_id
                        for (v_id, k_id, employee_id), var in drives.items()
                        if v_id == visit.id and k_id == vehicle.id and solver.Value(var)
                    ),
                    None,
                )
                if driver is not None:
                    chosen_vehicles.append(
                        VehicleAssignmentOutput(vehicle_id=vehicle.id, driver_employee_id=driver)
                    )

            lock = locks_by_visit.get(visit.id)
            pins_time = (
                lock is not None
                and lock.scope in ("FULL", "TIME")
                and lock.start_minute is not None
            )
            start = lock.start_minute if pins_time else visit.window_start_minute
            assignments.append(
                AssignmentOutput(
                    visit_id=visit.id,
                    employee_ids=crew,
                    vehicles=sorted(chosen_vehicles, key=lambda entry: entry.vehicle_id),
                    start_minute=start,
                )
            )
    else:
        for visit in visits:
            reasons = _why_unstaffable(request, visit) or ["NO_FEASIBLE_CREW"]
            unassigned.append(
                UnassignedOutput(
                    visit_id=visit.id,
                    reason_codes=reasons,
                    message=_message_for(reasons),
                )
            )

    return SolveResponse(
        run_id=request.run_id,
        status=status_name,
        # Sorted so two identical requests produce byte-identical output.
        assignments=sorted(assignments, key=lambda a: a.visit_id),
        unassigned=sorted(unassigned, key=lambda u: u.visit_id),
        solve_seconds=round(time.monotonic() - started, 3),
        objective_value=(
            int(solver.ObjectiveValue())
            if status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
            else 0
        ),
        visits_considered=len(visits),
    )


_MESSAGES = {
    "BRANCH_HAS_NO_PMS_SUPERVISOR": (
        "This branch employs no PMS-grade supervisor, so no crew from it can take the job."
    ),
    "NO_PMS_SUPERVISOR_AVAILABLE": (
        "No PMS-grade supervisor is free for this visit, and every job needs one."
    ),
    "CREW_TOO_SMALL": "Not enough eligible people are free to make up the crew.",
    "SKILL_NOT_HELD": "Nobody eligible and free holds a skill this job requires.",
    "WINDOW_TOO_SHORT": "The customer's window is shorter than the job takes.",
    "NO_FEASIBLE_CREW": (
        "No combination of available people satisfies every rule for this visit."
    ),
}


def _message_for(reasons: list[str]) -> str:
    return " ".join(_MESSAGES.get(code, code) for code in reasons)
