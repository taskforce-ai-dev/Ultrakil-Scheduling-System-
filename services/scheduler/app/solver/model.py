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
from collections import deque
from datetime import date, timedelta

from ortools.sat.python import cp_model

from app.solver.schemas import (
    AssignmentOutput,
    ReservationInput,
    SolveRequest,
    SolveResponse,
    UnassignedOutput,
    VehicleAssignmentOutput,
)

# Staffing a visit dominates every preference put together. The gap is wide on
# purpose: no combination of tidiness is worth leaving a customer unvisited.
# Start times land on the half hour. A crew's day is not planned to the minute,
# and the difference matters to the solver rather than to anyone reading the
# board: a nine-hour window is 18 candidate starts at this granularity and 540
# at one-minute steps. On a 1,200-visit week that is the difference between a
# schedule and a timeout, and a schedule nobody waited for is worth more than a
# theoretically tidier one that never arrives.
SLOT_GRANULARITY_MINUTES = 30
# Keep ordinary coverage visible when placing locks without rebuilding the
# unbounded whole-horizon model. The rest is still handled by daily solves.
LOCK_COVERAGE_LOOKAHEAD_LIMIT = 64

WEIGHT_VISIT_STAFFED = 10_000
WEIGHT_PREFERRED_DAY = 30
WEIGHT_KEEP_EXISTING_CREW = 20
WEIGHT_KEEP_EXISTING_VEHICLE = 10
WEIGHT_KEEP_EXISTING_TIME = 15
WEIGHT_WORKLOAD_SPREAD = 5
# A crew that can take a van should. Without a reward the solver has no reason
# to assign one at all, since a vehicle is optional — and a pest control crew
# arriving without their equipment is not a schedule anybody wanted.
WEIGHT_VEHICLE_ASSIGNED = 40


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

    if visit.candidate_slots == [] and not any(
        lock.visit_id == visit.id and lock.scope in ("FULL", "TIME")
        for lock in request.locks
    ):
        reasons.append("NO_FEASIBLE_TIME")
    if visit.candidate_slots:
        # `latest_start_minute` is the last moment the job could begin and still
        # finish before the site closes, so a slot with no room left is one
        # where the caller has already worked out the job does not fit. A
        # movable visit is only genuinely too tight when that is true of every
        # slot it could take.
        if not any(
            slot.earliest_start_minute <= slot.latest_start_minute for slot in visit.candidate_slots
        ):
            reasons.append("WINDOW_TOO_SHORT")
    elif visit.window_end_minute - visit.window_start_minute < visit.duration_minutes:
        reasons.append("WINDOW_TOO_SHORT")

    # A checkmark against a vehicle means that employee may drive it, and every
    # checked employee is equal — there is no owner and no preferred driver. So
    # a vehicle is usable by this visit exactly when someone who could serve the
    # visit is also checked against it. When no vehicle in the fleet clears that
    # bar, the model quietly assigns no vehicle; saying so is the difference
    # between a manager seeing "nobody who can serve this is checked for any
    # van" and seeing an unexplained blank.
    usable = [v for v in request.vehicles if _vehicle_serves_branch(v, visit)]
    authorized = [v for v in usable if any(v.id in e.authorized_vehicle_ids for e in eligible)]
    if usable and not authorized:
        reasons.append("NO_AUTHORIZED_DRIVER")

    drivable = [
        v
        for v in authorized
        if v.seat_capacity is None or v.seat_capacity >= visit.required_crew_size
    ]

    # With no vehicle this crew could take, everybody going has to travel by
    # public transport. Reported only when that is genuinely the binding
    # constraint: there is no drivable vehicle *and* too few people who could
    # make their own way to crew the job at all.
    if not drivable:
        walkers = [e for e in eligible if e.can_use_public_transport]
        if len(walkers) < visit.required_crew_size:
            reasons.append("CREW_CANNOT_TRAVEL")

    return reasons


def _vehicle_serves_branch(vehicle, visit) -> bool:
    """An unbranded vehicle goes anywhere; a branded one stays in its branch."""
    return vehicle.branch_code is None or vehicle.branch_code == visit.branch_code


def _employee_can_serve(employee, visit) -> bool:
    """The hard rules that depend on nothing but this one pairing.

    Availability is judged across every date the visit could take, not just the
    one it was generated on. Someone on leave that Tuesday is not a reason the
    visit cannot happen when Thursday is also allowed — and reporting them as
    unable to serve would put a reason in the Unassigned queue that the solver
    itself does not believe.
    """
    if employee.branch_code != visit.branch_code:
        return False

    dates = (
        {slot.date for slot in visit.candidate_slots}
        if visit.candidate_slots
        else {visit.visit_date}
    )
    if dates <= set(employee.unavailable_dates):
        return False

    if employee.is_permanently_stationed:
        return visit.service_site_id in employee.permanent_site_ids
    return True


def _lock_coverage_lookahead(request: SolveRequest, locked_visits: list) -> list:
    """Bound ordinary lookahead by eligibility and competing lock date/time.

    This is a deterministic sampling heuristic, not a global coverage proof.
    It runs no per-candidate solves. Only the returned visits enter CP-SAT.
    """
    def windows(visit):
        time_lock = next((lock for lock in request.locks
                          if lock.visit_id == visit.id and lock.scope in ("FULL", "TIME")), None)
        if time_lock is not None and time_lock.start_minute is not None:
            end = time_lock.end_minute or time_lock.start_minute + visit.duration_minutes
            return [(visit.visit_date, time_lock.start_minute, end)]
        if visit.candidate_slots is None:
            return [(visit.visit_date, visit.window_start_minute,
                     visit.window_start_minute + visit.duration_minutes)]
        return [
            (slot.date, slot.earliest_start_minute,
             min(slot.latest_start_minute, 1440 - visit.duration_minutes) + visit.duration_minutes)
            for slot in visit.candidate_slots
            if slot.earliest_start_minute <= min(
                slot.latest_start_minute, 1440 - visit.duration_minutes
            )
        ]

    def resources(visit):
        eligible = [employee for employee in request.employees
                    if _employee_can_serve(employee, visit)]
        vehicles = {vehicle.id for vehicle in request.vehicles
                    if _vehicle_serves_branch(vehicle, visit)
                    and (vehicle.seat_capacity is None
                         or vehicle.seat_capacity >= visit.required_crew_size)
                    and any(vehicle.id in employee.authorized_vehicle_ids for employee in eligible)}
        return {employee.id for employee in eligible}, vehicles

    locked_ids = {visit.id for visit in locked_visits}
    candidates = {}
    for visit in request.visits:
        if visit.id in locked_ids:
            continue
        # NO_AUTHORIZED_DRIVER alone is advisory: public transport can still
        # staff the job. Every other existing reason proves a hard-rule failure.
        if any(reason != "NO_AUTHORIZED_DRIVER" for reason in _why_unstaffable(request, visit)):
            continue
        candidate_windows = windows(visit)
        crew, vehicles = resources(visit)
        candidates[visit.id] = (visit, candidate_windows, crew, vehicles)

    def competing_queues(anchor):
        """One ranked queue per anchor date/time, including future alternatives."""
        anchor_crew, anchor_vehicles = resources(anchor)
        for day, start, end in sorted(set(windows(anchor))):
            ranked = []
            for visit, candidate_windows, crew, vehicles in candidates.values():
                if visit.id == anchor.id:
                    continue
                agreement = anchor.service_agreement_id
                same_agreement = bool(agreement and agreement == visit.service_agreement_id)
                if not (same_agreement or crew & anchor_crew or vehicles & anchor_vehicles):
                    continue
                on_day = [(opening, closing) for date, opening, closing in candidate_windows
                          if date == day]
                if not on_day:
                    continue
                conflicts = same_agreement or any(
                    opening < end and start < closing for opening, closing in on_day
                )
                date_count = len({window[0] for window in candidate_windows})
                rank = (not conflicts, date_count, len(crew) - visit.required_crew_size, visit.id)
                ranked.append((rank, visit))
            if ranked:
                yield deque(sorted(ranked, key=lambda entry: entry[0]))

    # Breadth-first expansion follows selected shadows to their other dates,
    # exposing demand that would otherwise be hidden by the lock-only horizon.
    # Keep all original candidates: shrinking a shadow's freedom can make the
    # model choose the wrong lock date. Round-robin limits domination by many
    # interchangeable competitors in one date/time bucket.
    queues = deque(queue for anchor in sorted(locked_visits, key=lambda visit: visit.id)
                   for queue in competing_queues(anchor))
    selected = {}
    while queues and len(selected) < LOCK_COVERAGE_LOOKAHEAD_LIMIT:
        queue = queues.popleft()
        while queue and queue[0][1].id in selected:
            queue.popleft()
        if not queue:
            continue
        _, visit = queue.popleft()
        selected[visit.id] = visit
        if len(selected) < LOCK_COVERAGE_LOOKAHEAD_LIMIT:
            queues.extend(competing_queues(visit))
        if queue:
            queues.append(queue)
    return list(selected.values())


def _may_take(visit, day: str, allowed_days: list[str]) -> bool:
    """Whether `day` may take `visit` yet, as the horizon is worked through.

    Days are solved in order, so without this a visit allowed on Tuesday and
    *preferred* on Thursday would always be taken by Tuesday and the customer's
    preference never honoured. Holding it back while one of its preferred days
    is still ahead costs nothing in coverage: if Thursday cannot take it, every
    later day still offers it.
    """
    if day not in allowed_days:
        return False

    preferred = {slot.date for slot in visit.candidate_slots or [] if slot.is_preferred}
    if not preferred or day in preferred:
        return True
    return not any(candidate >= day for candidate in preferred)


def solve(request: SolveRequest) -> SolveResponse:
    """Allocate manager locks jointly, then schedule ordinary work per day.

    Flexible locked visits link days: taking Tuesday's crew for a lock that
    could move to Thursday may strand another lock that can only use Tuesday.
    Solve those visits together with bounded ordinary coverage lookahead, then
    reserve the selected assignments. Eligible resource/time competitors get
    priority, with lookahead spread across the locks' possible dates and times.

    Measured on a real September week, 1,353 visits against 40 staff:

        one model, dates fixed      UNKNOWN, 0 staffed, 31s
        one model, dates free       UNKNOWN, 0 staffed, 28s
        per day (~193 visits)       190 of 200 staffed in the same budget

    The all-or-nothing collapse above roughly 700 visits in a single model is
    not new — the fixed-date model has it too. It has never been seen because
    the development database holds four active staff, and four staff cannot
    make the model large enough to hit it. It would have appeared the day
    UltraKIL's real matrix was loaded.

    A visit free to move is offered to each of its allowed days in turn and
    rolls forward while it stays unstaffed. This remains greedy for ordinary
    work outside the lookahead. Optimal submodels prove the maximum lock count
    and coverage within their inputs, not globally maximum ordinary coverage.
    """
    started = time.monotonic()

    visits = sorted(request.visits, key=lambda v: v.id)
    if not visits:
        return SolveResponse(
            run_id=request.run_id,
            status="OPTIMAL",
            assignments=[],
            unassigned=[],
            solve_seconds=round(time.monotonic() - started, 3),
            objective_value=0,
            visits_considered=0,
        )

    date_pinned = {
        lock.visit_id for lock in request.locks if lock.scope in ("FULL", "TIME")
    }

    def days_for(visit) -> list[str]:
        if visit.id in date_pinned:
            return [visit.visit_date]
        if visit.candidate_slots is None:
            return [visit.visit_date]
        return sorted({slot.date for slot in visit.candidate_slots})

    all_days = sorted({day for visit in visits for day in days_for(visit)})
    if len(all_days) <= 1:
        return _solve_window(request)

    # The limit is per day, not per run.
    #
    # Splitting one budget across the horizon looked tidier and was much worse:
    # a week at 30 seconds gave each day four, and four seconds is not enough
    # for two hundred visits against forty staff, so every day came back
    # UNKNOWN and the run staffed nothing. A solve is queued work a manager
    # started and walked away from, so spending a couple of minutes on a week
    # is cheap; coming back in thirty seconds with an empty schedule is not.
    per_day = request.time_limit_seconds

    pending = {visit.id: visit for visit in visits}
    assignments: list[AssignmentOutput] = []
    statuses: list[str] = []
    objective = 0
    locked_ids = {lock.visit_id for lock in request.locks} & pending.keys()
    reservations = list(request.reservations)
    reserved_agreement_days: set[tuple[str, str]] = set()

    if locked_ids:
        # Time locks ignore candidate dates. Normalize their candidates before
        # the joint solve so availability and preference logic use the pinned day.
        locked_visits = [
            visit.model_copy(update={"candidate_slots": None})
            if visit.id in date_pinned else visit
            for visit in visits if visit.id in locked_ids
        ]
        # Use real optional visits, not estimated penalties: all crew, skill,
        # travel, reservation and agreement/day rules apply to the lookahead.
        # Distinct locked visits always remain the first objective. Ordinary
        # coverage is second, ahead of every weekday/churn preference.
        lookahead = _lock_coverage_lookahead(request, locked_visits)
        allocation_ids = locked_ids | {visit.id for visit in lookahead}
        allocation = _solve_window(request.model_copy(update={
            "visits": locked_visits + lookahead,
            "locks": [lock for lock in request.locks if lock.visit_id in locked_ids],
            "existing": [row for row in request.existing if row.visit_id in allocation_ids],
        }))
        statuses.append(allocation.status)
        objective += allocation.objective_value
        # Preserve the whole joint coverage witness. Re-solving its ordinary
        # visits greedily can discard coverage through preferred-day holdback.
        # The lookahead follows outside-date competition before this solve;
        # coverage beyond that bounded sample remains heuristic, not optimal.
        for assignment in allocation.assignments:
            visit = pending.pop(assignment.visit_id)
            assignments.append(assignment)
            time_lock = next(
                (lock for lock in request.locks
                 if lock.visit_id == visit.id and lock.scope in ("FULL", "TIME")),
                None,
            )
            end = (
                time_lock.end_minute
                if time_lock is not None and time_lock.end_minute is not None
                else assignment.start_minute + visit.duration_minutes
            )
            reservations.append(ReservationInput(
                scheduled_date=assignment.scheduled_date,
                start_minute=assignment.start_minute,
                end_minute=end,
                service_site_id=visit.service_site_id,
                employee_ids=assignment.employee_ids,
                vehicle_ids=[vehicle.vehicle_id for vehicle in assignment.vehicles],
            ))
            if visit.service_agreement_id:
                reserved_agreement_days.add((visit.service_agreement_id, assignment.scheduled_date))

    for day in all_days:
        todays = [
            visit for visit in pending.values()
            if visit.id not in locked_ids
            and (visit.service_agreement_id, day) not in reserved_agreement_days
            and _may_take(visit, day, days_for(visit))
        ]
        if not todays:
            continue

        # Each visit is offered only this day's slots, so the sub-model has one
        # day on its timeline and the start variable chooses the time within it.
        narrowed = []
        for visit in todays:
            slots = (
                None if visit.id in date_pinned or visit.candidate_slots is None
                else [slot for slot in visit.candidate_slots or [] if slot.date == day]
            )
            narrowed.append(visit.model_copy(update={"visit_date": day, "candidate_slots": slots}))

        ids = {visit.id for visit in narrowed}
        result = _solve_window(
            request.model_copy(
                update={
                    "visits": narrowed,
                    "locks": [lock for lock in request.locks if lock.visit_id in ids],
                    "existing": [row for row in request.existing if row.visit_id in ids],
                    "reservations": reservations,
                    "time_limit_seconds": per_day,
                }
            )
        )

        statuses.append(result.status)
        objective += result.objective_value
        for assignment in result.assignments:
            assignments.append(assignment)
            # Staffed is settled. Anything left stays pending and is offered to
            # its next allowed day.
            visit = pending.pop(assignment.visit_id, None)
            if visit is not None:
                reservations.append(ReservationInput(
                    scheduled_date=assignment.scheduled_date,
                    start_minute=assignment.start_minute,
                    end_minute=assignment.start_minute + visit.duration_minutes,
                    service_site_id=visit.service_site_id,
                    employee_ids=assignment.employee_ids,
                    vehicle_ids=[
                        vehicle.vehicle_id for vehicle in assignment.vehicles
                    ],
                ))

    # Whatever no day could take. The reasons are computed against the original
    # request so they describe the visit as the manager sees it, not as one
    # day's narrowed copy.
    unassigned = [
        UnassignedOutput(
            visit_id=visit.id,
            reason_codes=(_why_unstaffable(request, visit) or ["NO_FEASIBLE_CREW"]),
            message=_message_for(_why_unstaffable(request, visit) or ["NO_FEASIBLE_CREW"]),
            reason_messages={
                code: _MESSAGES.get(code, code)
                for code in (_why_unstaffable(request, visit) or ["NO_FEASIBLE_CREW"])
            },
        )
        for visit in pending.values()
    ]

    # Daily optimality does not prove global optimality for greedy ordinary work.
    if any(status == "UNKNOWN" for status in statuses):
        status_name = "UNKNOWN"
    elif any(status in ("OPTIMAL", "FEASIBLE") for status in statuses):
        status_name = "FEASIBLE"
    else:
        status_name = "INFEASIBLE"

    return SolveResponse(
        run_id=request.run_id,
        status=status_name,
        assignments=sorted(assignments, key=lambda a: a.visit_id),
        unassigned=sorted(unassigned, key=lambda u: u.visit_id),
        solve_seconds=round(time.monotonic() - started, 3),
        objective_value=objective,
        visits_considered=len(visits),
    )


def _solve_window(request: SolveRequest) -> SolveResponse:
    """One constraint model over whatever visits it is given.

    Kept deliberately unaware of the decomposition above it: it solves the set
    it receives and says what it managed. That is what lets `solve` hand it a
    single day without this code needing to know a day is what it is looking
    at.
    """
    started = time.monotonic()
    model = cp_model.CpModel()

    # Sorted so the model is built identically however the API happened to
    # order the rows. Without this, two identical schedules could differ purely
    # because Postgres returned employees in another order — and a manager
    # rerunning to compare would see phantom changes.
    visits = sorted(request.visits, key=lambda v: v.id)
    employees = sorted(request.employees, key=lambda e: e.id)
    vehicles = sorted(request.vehicles, key=lambda k: k.id)

    locks_by_visit = {}
    for lock in sorted(request.locks, key=lambda entry: (entry.visit_id, entry.scope)):
        locks_by_visit.setdefault(lock.visit_id, []).append(lock)
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

    # --- When each visit happens ------------------------------------------
    #
    # This is the decision the old model never made. It read the date off the
    # visit and started every job at the top of its window, so generation chose
    # the day and the solver could only choose people to fit around it. A
    # Tuesday visit with no free supervisor stayed unstaffed even when Thursday
    # was wide open.
    #
    # Now each visit carries the dates and times it is legally allowed to take,
    # and the start is a variable over exactly those values. Date, time, crew
    # and vehicle come out of one optimisation, which is what lets it trade a
    # day to cover another job.
    #
    # A null/omitted candidate list retains the legacy fixed-window fallback.
    # An explicit empty list is impossible work, not permission to staff it.
    represented_dates = sorted(
        {v.visit_date for v in visits}
        | {slot.date for v in visits for slot in v.candidate_slots or []}
        | {
            reservation.scheduled_date
            for reservation in request.reservations
            if reservation.assignment_id not in set(request.excluded_reservation_assignment_ids)
        }
    )
    first_date = date.fromisoformat(represented_dates[0])
    last_date = date.fromisoformat(represented_dates[-1])
    all_dates = [
        (first_date + timedelta(days=offset)).isoformat()
        for offset in range((last_date - first_date).days + 1)
    ]
    day_index = {date: index for index, date in enumerate(all_dates)}

    def time_lock(v):
        return next(
            (
                entry
                for entry in locks_by_visit.get(v.id, [])
                if entry.scope in ("FULL", "TIME")
            ),
            None,
        )

    def scheduled_duration(v) -> int:
        """Reserve the manager's exact valid interval, not only its minimum."""
        lock = time_lock(v)
        if (
            lock is not None
            and lock.start_minute is not None
            and lock.end_minute is not None
            and lock.end_minute - lock.start_minute >= v.duration_minutes
        ):
            return lock.end_minute - lock.start_minute
        return v.duration_minutes

    def slot_starts(v) -> list[int]:
        """Every absolute start minute this visit may legally take.

        Absolute means minutes from the first day of the horizon, so a single
        integer carries both the date and the time and two visits on different
        days can never be found to overlap.
        """
        lock = time_lock(v)
        if (
            lock is not None
            and lock.scope in ("FULL", "TIME")
            and lock.start_minute is not None
        ):
            return [day_index[v.visit_date] * 1440 + lock.start_minute]
        if v.candidate_slots is None:
            base = day_index[v.visit_date] * 1440 + v.window_start_minute
            return [base]

        starts: list[int] = []
        occupied = {(key.date, key.start_minute) for key in v.occupied_start_keys}
        for slot in v.candidate_slots or []:
            if slot.date not in day_index:
                continue
            offset = day_index[slot.date] * 1440
            latest = min(slot.latest_start_minute, 1440 - v.duration_minutes)
            minute = slot.earliest_start_minute
            while minute <= latest:
                if (slot.date, minute) not in occupied:
                    starts.append(offset + minute)
                minute += SLOT_GRANULARITY_MINUTES
        return sorted(set(starts))

    start_of: dict[str, object] = {}
    for v in visits:
        starts = slot_starts(v)
        if not starts:
            # No legal slot at all. Nothing to choose, and staffing it would
            # mean putting a crew somewhere the customer is shut.
            model.Add(staffed[v.id] == 0)
            starts = [day_index[v.visit_date] * 1440 + v.window_start_minute]
        start_of[v.id] = model.NewIntVarFromDomain(
            cp_model.Domain.FromValues(starts), f"start_{v.id}"
        )

    # One staffed visit per agreement per selected day, including the joint
    # locked-visit solve where two visits may legally occupy different days.
    by_agreement: dict[str, list] = {}
    for v in visits:
        if v.service_agreement_id:
            by_agreement.setdefault(v.service_agreement_id, []).append(v)
    for agreement_id, same_agreement in by_agreement.items():
        if len(same_agreement) < 2:
            continue
        intervals = []
        for v in same_agreement:
            selected_day = model.NewIntVar(0, len(all_dates) - 1, f"day_{v.id}")
            model.AddDivisionEquality(selected_day, start_of[v.id], 1440)
            intervals.append(model.NewOptionalFixedSizeIntervalVar(
                selected_day, 1, staffed[v.id], f"agreement_{agreement_id}_{v.id}"
            ))
        model.AddNoOverlap(intervals)

    # An employee who cannot work a date cannot be on a visit that lands on it.
    # Expressed against the start variable rather than by dropping the pairing,
    # because the pairing is legal on the other candidate dates.
    for v in visits:
        if not v.candidate_slots:
            continue
        legal = slot_starts(v)
        for employee in employees:
            var = assign.get((v.id, employee.id))
            if var is None or not employee.unavailable_dates:
                continue
            available = [
                minute
                for minute in legal
                if all_dates[minute // 1440] not in employee.unavailable_dates
            ]
            if not available:
                model.Add(var == 0)
            elif len(available) < len(legal):
                model.AddLinearExpressionInDomain(
                    start_of[v.id], cp_model.Domain.FromValues(available)
                ).OnlyEnforceIf(var)

    # "Landed on a weekday the customer prefers" as something the objective can
    # score. Reified against the start variable, so it is true exactly when the
    # chosen slot is one of the preferred ones.
    preferred_landing: dict[str, object] = {}
    for v in visits:
        if not v.candidate_slots:
            continue
        preferred_dates = {slot.date for slot in v.candidate_slots or [] if slot.is_preferred}
        if not preferred_dates:
            continue

        legal = slot_starts(v)
        wanted = [m for m in legal if all_dates[m // 1440] in preferred_dates]
        if not wanted or len(wanted) == len(legal):
            # Nothing to trade off: either no preferred slot is reachable, or
            # every one of them is. A literal here would only add work.
            continue

        landed = model.NewBoolVar(f"pref_{v.id}")
        model.AddLinearExpressionInDomain(
            start_of[v.id], cp_model.Domain.FromValues(wanted)
        ).OnlyEnforceIf(landed)
        model.AddLinearExpressionInDomain(
            start_of[v.id],
            cp_model.Domain.FromValues([m for m in legal if m not in set(wanted)]),
        ).OnlyEnforceIf(landed.Not())
        # Only worth anything if the visit actually happens.
        model.AddImplication(landed, staffed[v.id])
        preferred_landing[v.id] = landed

    # Start the search from the schedule that already exists.
    #
    # Letting the solver choose the day multiplies the search space, and on a
    # real week — 1,300 visits, each with a dozen legal slots — it can spend
    # the whole time budget without ever finding a good arrangement, and come
    # back with less than the fixed-date model managed. A hint costs nothing
    # and removes that cliff: CP-SAT begins from the generated dates, so the
    # answer is at worst the schedule we had before and usually better.
    #
    # Hints do not affect reproducibility. With one worker and a fixed seed the
    # same request still returns the same schedule; it simply gets there from a
    # sensible place instead of from nothing.
    for v in visits:
        if not v.candidate_slots:
            continue
        generated = day_index[v.visit_date] * 1440 + v.window_start_minute
        legal = slot_starts(v)
        model.AddHint(start_of[v.id], generated if generated in legal else legal[0])

    def absolute_start(v):
        """The visit's start on the horizon timeline — now a variable."""
        return start_of[v.id]

    reservations = [
        reservation
        for reservation in request.reservations
        if reservation.assignment_id not in set(request.excluded_reservation_assignment_ids)
    ]

    def reservation_interval(reservation, resource_id: str, kind: str):
        resource_ids = reservation.employee_ids if kind == "employee" else reservation.vehicle_ids
        if resource_id not in resource_ids:
            return None
        duration = reservation.end_minute - reservation.start_minute
        if duration <= 0:
            return None
        start = day_index[reservation.scheduled_date] * 1440 + reservation.start_minute
        return model.NewFixedSizeIntervalVar(
            start, duration, f"reserved_{kind}_{resource_id}_{reservation.assignment_id or start}"
        )

    def add_different_site_visit_pair_gap(
        left,
        left_present,
        right,
        right_present,
        resource_name: str,
    ) -> None:
        buffer = request.minimum_travel_buffer_minutes
        if buffer == 0 or left.service_site_id == right.service_site_id:
            return
        left_starts = slot_starts(left)
        right_starts = slot_starts(right)
        if not left_starts or not right_starts:
            return
        if (
            max(left_starts) + scheduled_duration(left) + buffer
            <= min(right_starts)
            or max(right_starts) + scheduled_duration(right) + buffer
            <= min(left_starts)
        ):
            return
        left_before = model.NewBoolVar(f"travel_before_{resource_name}_{left.id}_{right.id}")
        right_before = model.NewBoolVar(f"travel_before_{resource_name}_{right.id}_{left.id}")
        model.Add(
            absolute_start(left) + scheduled_duration(left) + buffer
            <= absolute_start(right)
        ).OnlyEnforceIf(left_before)
        model.Add(
            absolute_start(right) + scheduled_duration(right) + buffer
            <= absolute_start(left)
        ).OnlyEnforceIf(right_before)
        model.AddBoolOr([
            left_before,
            right_before,
            left_present.Not(),
            right_present.Not(),
        ])

    def add_different_site_reservation_gap(
        visit,
        visit_present,
        reservation,
        resource_name: str,
    ) -> None:
        buffer = request.minimum_travel_buffer_minutes
        if (
            buffer == 0
            or reservation.service_site_id is None
            or reservation.service_site_id == visit.service_site_id
        ):
            return
        reserved_start = (
            day_index[reservation.scheduled_date] * 1440 + reservation.start_minute
        )
        reserved_end = day_index[reservation.scheduled_date] * 1440 + reservation.end_minute
        visit_starts = slot_starts(visit)
        if not visit_starts:
            return
        if (
            max(visit_starts) + scheduled_duration(visit) + buffer <= reserved_start
            or reserved_end + buffer <= min(visit_starts)
        ):
            return
        reservation_key = reservation.assignment_id or reserved_start
        visit_before = model.NewBoolVar(
            f"travel_before_{resource_name}_{visit.id}_{reservation_key}"
        )
        reservation_before = model.NewBoolVar(
            f"travel_before_{resource_name}_{reservation_key}_{visit.id}"
        )
        model.Add(
            absolute_start(visit) + scheduled_duration(visit) + buffer <= reserved_start
        ).OnlyEnforceIf(visit_before)
        model.Add(
            reserved_end + buffer <= absolute_start(visit)
        ).OnlyEnforceIf(reservation_before)
        model.AddBoolOr([visit_before, reservation_before, visit_present.Not()])

    for employee in employees:
        intervals = [
            interval
            for reservation in reservations
            if (interval := reservation_interval(reservation, employee.id, "employee")) is not None
        ]
        for v in visits:
            var = assign.get((v.id, employee.id))
            if var is None:
                continue
            start = absolute_start(v)
            duration = scheduled_duration(v)
            intervals.append(
                model.NewOptionalIntervalVar(
                    start,
                    duration,
                    start + duration,
                    var,
                    f"i_{v.id}_{employee.id}",
                )
            )
        if len(intervals) > 1:
            model.AddNoOverlap(intervals)
        employee_visits = [
            visit for visit in visits if (visit.id, employee.id) in assign
        ]
        for index, left in enumerate(employee_visits):
            for right in employee_visits[index + 1:]:
                add_different_site_visit_pair_gap(
                    left,
                    assign[left.id, employee.id],
                    right,
                    assign[right.id, employee.id],
                    f"employee_{employee.id}",
                )
            for reservation in reservations:
                if employee.id in reservation.employee_ids:
                    add_different_site_reservation_gap(
                        left,
                        assign[left.id, employee.id],
                        reservation,
                        f"employee_{employee.id}",
                    )

    for vehicle in vehicles:
        intervals = [
            interval
            for reservation in reservations
            if (interval := reservation_interval(reservation, vehicle.id, "vehicle")) is not None
        ]
        for v in visits:
            var = uses_vehicle.get((v.id, vehicle.id))
            if var is None:
                continue
            start = absolute_start(v)
            duration = scheduled_duration(v)
            intervals.append(
                model.NewOptionalIntervalVar(
                    start,
                    duration,
                    start + duration,
                    var,
                    f"iv_{v.id}_{vehicle.id}",
                )
            )
        if len(intervals) > 1:
            model.AddNoOverlap(intervals)
        vehicle_visits = [
            visit for visit in visits if (visit.id, vehicle.id) in uses_vehicle
        ]
        for index, left in enumerate(vehicle_visits):
            for right in vehicle_visits[index + 1:]:
                add_different_site_visit_pair_gap(
                    left,
                    uses_vehicle[left.id, vehicle.id],
                    right,
                    uses_vehicle[right.id, vehicle.id],
                    f"vehicle_{vehicle.id}",
                )
            for reservation in reservations:
                if vehicle.id in reservation.vehicle_ids:
                    add_different_site_reservation_gap(
                        left,
                        uses_vehicle[left.id, vehicle.id],
                        reservation,
                        f"vehicle_{vehicle.id}",
                    )

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

    # How the crew gets there: at most one vehicle, and everybody covered.
    for visit in visits:
        vehicle_vars = [
            uses_vehicle[visit.id, vehicle.id]
            for vehicle in vehicles
            if (visit.id, vehicle.id) in uses_vehicle
        ]

        # One vehicle per visit.
        #
        # The crew travels together and the capacity rule above already refuses
        # any vehicle that cannot seat all of them, so a second vehicle was
        # never carrying anybody. It was not merely redundant: every assigned
        # vehicle earns WEIGHT_VEHICLE_ASSIGNED, so with no cap the model
        # collected every free vehicle onto one job for the points and left
        # later visits with nothing to drive. A fleet is shared across a day.
        if len(vehicle_vars) > 1:
            model.Add(sum(vehicle_vars) <= 1)

        # Getting there when no vehicle goes.
        #
        # A crew with no vehicle travels by public transport, and each person
        # makes that journey themselves — there is nothing to share. So the rule
        # is every member, not one: anybody not check-marked for public
        # transport can only go on a visit that takes a vehicle.
        #
        # Written per employee rather than per crew because that is what the
        # model can express directly: assigning someone who cannot get there
        # forces a vehicle onto the visit, and where the fleet offers none,
        # forces them off.
        for employee in employees:
            var = assign.get((visit.id, employee.id))
            if var is None or employee.can_use_public_transport:
                continue
            if vehicle_vars:
                model.Add(sum(vehicle_vars) >= 1).OnlyEnforceIf(var)
            else:
                model.Add(var == 0)

    # --- Manager locks ------------------------------------------------------
    #
    # A lock is a hard constraint, not a preference. It can never make an
    # invalid assignment valid, though: the rules above still apply, so a lock
    # on an impossible crew simply leaves the visit unassigned.
    for visit in visits:
        for lock in locks_by_visit.get(visit.id, []):
            if (
                lock.scope in ("FULL", "TIME")
                and lock.end_minute is not None
                and (
                    lock.start_minute is None
                    or lock.end_minute - lock.start_minute < visit.duration_minutes
                    or lock.start_minute < visit.window_start_minute
                    or lock.end_minute > visit.window_end_minute
                )
            ):
                model.Add(staffed[visit.id] == 0)

            if lock.scope in ("FULL", "CREW"):
                for employee in employees:
                    var = assign.get((visit.id, employee.id))
                    if var is not None:
                        model.Add(
                            var == (1 if employee.id in lock.employee_ids else 0)
                        ).OnlyEnforceIf(staffed[visit.id])
                if any((visit.id, employee_id) not in assign for employee_id in lock.employee_ids):
                    model.Add(staffed[visit.id] == 0)

            if lock.scope == "SUPERVISOR":
                # Pin the manager's chosen lead, not every crew member. The API
                # retains the role on write and checks it again under row lock.
                for employee_id in lock.employee_ids:
                    var = assign.get((visit.id, employee_id))
                    employee = next((e for e in employees if e.id == employee_id), None)
                    if var is None or employee is None or not employee.is_pms_grade:
                        model.Add(staffed[visit.id] == 0)
                    else:
                        model.Add(var == 1).OnlyEnforceIf(staffed[visit.id])

            if lock.scope in ("FULL", "VEHICLE"):
                for vehicle in vehicles:
                    var = uses_vehicle.get((visit.id, vehicle.id))
                    if var is not None:
                        model.Add(
                            var == (1 if vehicle.id in lock.vehicle_ids else 0)
                        ).OnlyEnforceIf(staffed[visit.id])
                if any(
                    (visit.id, vehicle_id) not in uses_vehicle for vehicle_id in lock.vehicle_ids
                ):
                    model.Add(staffed[visit.id] == 0)
                for mapping in lock.vehicle_drivers:
                    if mapping.driver_employee_id is None:
                        model.Add(staffed[visit.id] == 0)
                        continue
                    drive = drives.get((visit.id, mapping.vehicle_id, mapping.driver_employee_id))
                    if drive is None:
                        model.Add(staffed[visit.id] == 0)
                    else:
                        model.Add(drive == 1).OnlyEnforceIf(staffed[visit.id])

    # --- Soft preferences ---------------------------------------------------

    terms: list[tuple[int, cp_model.IntVar]] = []

    for visit in visits:
        # The customer's preferred weekday. On a pinned visit the date is
        # already decided, so this is a flat bonus for having landed on one. On
        # a movable visit it has to follow the choice: a bonus that ignored
        # where the solver actually put it would reward preference it never
        # delivered. The bound below makes all preferences together worth less
        # than one additional staffed visit.
        preferred = preferred_landing.get(visit.id)
        if preferred is not None:
            terms.append((WEIGHT_PREFERRED_DAY, preferred))
        elif visit.is_preferred_day:
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

            # Keeping the published/draft start makes a correction easier for
            # dispatch to understand. It remains a preference: an occupied or
            # otherwise illegal time is absent from the variable's domain and
            # receives no term, so reservations and every hard rule still win.
            if existing.start_minute is not None:
                wanted_start = day_index[visit.visit_date] * 1440 + existing.start_minute
                if wanted_start in slot_starts(visit):
                    kept_time = model.NewBoolVar(f"keep_time_{visit.id}")
                    model.Add(start_of[visit.id] == wanted_start).OnlyEnforceIf(kept_time)
                    model.AddImplication(kept_time, staffed[visit.id])
                    terms.append((WEIGHT_KEEP_EXISTING_TIME, kept_time))

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

    # Exact lexicographic tiers: lock count, total coverage, then preferences.
    # Each multiplier exceeds the full possible range of every lower tier;
    # a constant staffing reward alone is not sufficient on a large input.
    preference_range = sum(abs(weight) for weight, _ in terms)
    preference_range += WEIGHT_WORKLOAD_SPREAD * len(visits)
    coverage_weight = max(WEIGHT_VISIT_STAFFED, preference_range + 1)
    objective += coverage_weight * sum(staffed.values())

    # An additional protected visit outweighs the entire possible range of
    # ordinary staffing and preferences, including the negative workload term.
    # Count visits once even when a manager has applied several lock scopes.
    locked_staffed = [staffed[v.id] for v in visits if v.id in locks_by_visit]
    if locked_staffed:
        lower_priority_range = coverage_weight * len(visits) + preference_range
        objective += (lower_priority_range + 1) * sum(locked_staffed)

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
                        reason_messages={code: _MESSAGES.get(code, code) for code in reasons},
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

            # Where the solver put it. A time lock still wins outright: the
            # manager's decision is a hard constraint, and reporting anything
            # else would be reporting a schedule the crews were not given.
            lock = next(
                (
                    entry
                    for entry in locks_by_visit.get(visit.id, [])
                    if entry.scope in ("FULL", "TIME")
                ),
                None,
            )
            pins_time = (
                lock is not None
                and lock.scope in ("FULL", "TIME")
                and lock.start_minute is not None
            )
            absolute = solver.Value(start_of[visit.id])
            scheduled_date = all_dates[absolute // 1440]
            start = lock.start_minute if pins_time else absolute % 1440

            assignments.append(
                AssignmentOutput(
                    visit_id=visit.id,
                    employee_ids=crew,
                    vehicles=sorted(chosen_vehicles, key=lambda entry: entry.vehicle_id),
                    start_minute=start,
                    scheduled_date=scheduled_date,
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
                    reason_messages={code: _MESSAGES.get(code, code) for code in reasons},
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
            int(solver.ObjectiveValue()) if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else 0
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
    "NO_FEASIBLE_TIME": (
        "The visit has no legal start time on its current date or allowed days within "
        "the site's opening hours. Confirm hours or adjust the visit."
    ),
    "NO_AUTHORIZED_DRIVER": (
        "Nobody who could serve this visit is authorized to drive any available vehicle."
    ),
    "CREW_CANNOT_TRAVEL": (
        "No vehicle is available for this visit and too few of the people who "
        "could serve it can travel by public transport."
    ),
    "NO_FEASIBLE_CREW": ("No combination of available people satisfies every rule for this visit."),
}


def _message_for(reasons: list[str]) -> str:
    return " ".join(_MESSAGES.get(code, code) for code in reasons)
