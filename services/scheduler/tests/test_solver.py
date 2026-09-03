"""Solver tests.

Every hard rule gets a case that would pass if the rule were missing, so a
regression shows up as a crew somewhere it must not be rather than as a
slightly worse score. The soft preferences get cases too, but only ever as
tie-breaks: a test that let a preference drop a visit would be encoding the
opposite of the rule.
"""

from __future__ import annotations

import pytest

from app.solver.model import solve
from app.solver.schemas import (
    EmployeeInput,
    ExistingAssignmentInput,
    LockInput,
    SolveRequest,
    VehicleInput,
    VisitInput,
)

SITE = "site-1"


def visit(**overrides) -> VisitInput:
    base = dict(
        id="visit-1",
        branch_code="COLOMBO",
        visit_date="2026-09-09",
        window_start_minute=9 * 60,
        window_end_minute=17 * 60,
        duration_minutes=90,
        required_crew_size=2,
        required_skill_codes=[],
        service_site_id=SITE,
        is_preferred_day=False,
    )
    base.update(overrides)
    return VisitInput(**base)


def employee(**overrides) -> EmployeeInput:
    base = dict(id="emp-1", branch_code="COLOMBO", is_pms_grade=False)
    base.update(overrides)
    return EmployeeInput(**base)


SUPERVISOR = employee(id="sup-1", is_pms_grade=True)
TECHNICIAN = employee(id="tech-1")


def request(**overrides) -> SolveRequest:
    base = dict(
        run_id="run-1",
        visits=[visit()],
        employees=[SUPERVISOR, TECHNICIAN],
        vehicles=[],
        locks=[],
        existing=[],
        time_limit_seconds=5.0,
    )
    base.update(overrides)
    return SolveRequest(**base)


class TestHappyPath:
    def test_staffs_a_visit_with_an_eligible_crew(self):
        result = solve(request())

        assert result.status in ("OPTIMAL", "FEASIBLE")
        assert len(result.assignments) == 1
        assert result.assignments[0].employee_ids == ["sup-1", "tech-1"]
        assert result.unassigned == []

    def test_starts_the_visit_at_the_window_open(self):
        result = solve(request())
        assert result.assignments[0].start_minute == 9 * 60


class TestHardRules:
    def test_never_sends_a_crew_across_branches(self):
        kandy = employee(id="k-1", branch_code="KANDY", is_pms_grade=True)
        other = employee(id="k-2", branch_code="KANDY")

        result = solve(request(employees=[kandy, other]))

        assert result.assignments == []
        assert result.unassigned[0].reason_codes  # explained, not silent

    def test_every_staffed_visit_has_a_pms_supervisor(self):
        # The branch has a supervisor, but she is on leave that day — so the
        # answer is "none available", not "this branch has none at all".
        away = employee(id="sup-1", is_pms_grade=True, unavailable_dates=["2026-09-09"])

        result = solve(request(employees=[away, TECHNICIAN, employee(id="tech-2")]))

        assert result.assignments == []
        assert "NO_PMS_SUPERVISOR_AVAILABLE" in result.unassigned[0].reason_codes

    def test_names_a_branch_with_no_supervisor_at_all(self):
        # Kandy's real situation: "add a supervisor" is not advice anyone can act on.
        kandy_visit = visit(branch_code="KANDY")
        crew = [
            employee(id="k-1", branch_code="KANDY"),
            employee(id="k-2", branch_code="KANDY"),
        ]

        result = solve(request(visits=[kandy_visit], employees=crew))

        assert "BRANCH_HAS_NO_PMS_SUPERVISOR" in result.unassigned[0].reason_codes

    def test_will_not_move_permanently_stationed_staff(self):
        stationed = employee(
            id="perm-1", is_permanently_stationed=True, permanent_site_ids=["elsewhere"]
        )

        result = solve(request(employees=[SUPERVISOR, stationed]))

        assert result.assignments == []

    def test_keeps_permanently_stationed_staff_at_their_own_site(self):
        stationed = employee(
            id="perm-1", is_permanently_stationed=True, permanent_site_ids=[SITE]
        )

        result = solve(request(employees=[SUPERVISOR, stationed]))

        assert result.assignments[0].employee_ids == ["perm-1", "sup-1"]

    def test_respects_leave(self):
        away = employee(id="tech-1", unavailable_dates=["2026-09-09"])

        result = solve(request(employees=[SUPERVISOR, away]))

        assert result.assignments == []

    def test_covers_every_required_skill(self):
        skilled = employee(id="tech-1", skill_codes=["FUMIGATION"])

        without = solve(request(visits=[visit(required_skill_codes=["FUMIGATION"])]))
        assert "SKILL_NOT_HELD" in without.unassigned[0].reason_codes

        with_skill = solve(
            request(
                visits=[visit(required_skill_codes=["FUMIGATION"])],
                employees=[SUPERVISOR, skilled],
            )
        )
        assert len(with_skill.assignments) == 1

    def test_never_double_books_a_person(self):
        # Two overlapping visits, only one possible crew between them.
        first = visit(id="v-1")
        second = visit(id="v-2")

        result = solve(request(visits=[first, second]))

        assert len(result.assignments) == 1
        assert len(result.unassigned) == 1

    def test_allows_the_same_crew_on_visits_that_do_not_overlap(self):
        morning = visit(id="v-1", window_start_minute=8 * 60, duration_minutes=60)
        afternoon = visit(id="v-2", window_start_minute=13 * 60, duration_minutes=60)

        result = solve(request(visits=[morning, afternoon]))

        assert len(result.assignments) == 2

    def test_refuses_a_window_shorter_than_the_job(self):
        cramped = visit(window_start_minute=9 * 60, window_end_minute=10 * 60, duration_minutes=180)

        result = solve(request(visits=[cramped]))

        assert "WINDOW_TOO_SHORT" in result.unassigned[0].reason_codes


class TestVehicles:
    def test_only_assigns_a_vehicle_somebody_going_can_drive(self):
        van = VehicleInput(id="van-1", branch_code="COLOMBO", seat_capacity=4)
        driver = employee(id="sup-1", is_pms_grade=True, authorized_vehicle_ids=["van-1"])

        result = solve(request(employees=[driver, TECHNICIAN], vehicles=[van]))

        assert result.assignments[0].vehicles[0].vehicle_id == "van-1"
        assert result.assignments[0].vehicles[0].driver_employee_id == "sup-1"

    def test_leaves_the_vehicle_behind_when_nobody_can_drive_it(self):
        van = VehicleInput(id="van-1", branch_code="COLOMBO", seat_capacity=4)

        result = solve(request(vehicles=[van]))

        # The visit is still staffed — a crew on public transport is valid.
        assert len(result.assignments) == 1
        assert result.assignments[0].vehicles == []

    def test_will_not_overfill_a_vehicle(self):
        bike = VehicleInput(id="bike-1", branch_code="COLOMBO", seat_capacity=1)
        driver = employee(id="sup-1", is_pms_grade=True, authorized_vehicle_ids=["bike-1"])

        result = solve(request(employees=[driver, TECHNICIAN], vehicles=[bike]))

        assert result.assignments[0].vehicles == []

    def test_never_sends_one_vehicle_to_two_overlapping_visits(self):
        van = VehicleInput(id="van-1", branch_code="COLOMBO", seat_capacity=4)
        drivers = [
            employee(id="sup-1", is_pms_grade=True, authorized_vehicle_ids=["van-1"]),
            employee(id="sup-2", is_pms_grade=True, authorized_vehicle_ids=["van-1"]),
            employee(id="tech-1"),
            employee(id="tech-2"),
        ]
        overlapping = [visit(id="v-1"), visit(id="v-2")]

        result = solve(request(visits=overlapping, employees=drivers, vehicles=[van]))

        with_van = [a for a in result.assignments if a.vehicles]
        assert len(with_van) <= 1

    def test_uses_a_vehicle_with_no_recorded_branch(self):
        # The matrix does not give every van a branch. Unknown is not wrong.
        van = VehicleInput(id="van-x", branch_code=None, seat_capacity=4)
        driver = employee(id="sup-1", is_pms_grade=True, authorized_vehicle_ids=["van-x"])

        result = solve(request(employees=[driver, TECHNICIAN], vehicles=[van]))

        assert result.assignments[0].vehicles[0].vehicle_id == "van-x"


class TestLocks:
    def test_a_locked_crew_survives_a_rerun(self):
        # Two equally good crews exist; the lock decides.
        pool = [
            SUPERVISOR,
            employee(id="sup-2", is_pms_grade=True),
            TECHNICIAN,
            employee(id="tech-2"),
        ]
        lock = LockInput(visit_id="visit-1", scope="CREW", employee_ids=["sup-2", "tech-2"])

        result = solve(request(employees=pool, locks=[lock]))

        assert result.assignments[0].employee_ids == ["sup-2", "tech-2"]

    def test_a_lock_cannot_make_an_illegal_crew_legal(self):
        # Locked to two technicians — no supervisor. The hard rule still wins,
        # so the visit goes unassigned rather than being staffed illegally.
        pool = [TECHNICIAN, employee(id="tech-2")]
        lock = LockInput(visit_id="visit-1", scope="CREW", employee_ids=["tech-1", "tech-2"])

        result = solve(request(employees=pool, locks=[lock]))

        assert result.assignments == []
        assert result.unassigned[0].visit_id == "visit-1"

    def test_a_time_lock_sets_the_start(self):
        lock = LockInput(visit_id="visit-1", scope="TIME", start_minute=11 * 60)

        result = solve(request(locks=[lock]))

        assert result.assignments[0].start_minute == 11 * 60

    def test_a_vehicle_lock_is_honoured(self):
        vans = [
            VehicleInput(id="van-1", branch_code="COLOMBO", seat_capacity=4),
            VehicleInput(id="van-2", branch_code="COLOMBO", seat_capacity=4),
        ]
        driver = employee(
            id="sup-1", is_pms_grade=True, authorized_vehicle_ids=["van-1", "van-2"]
        )
        lock = LockInput(visit_id="visit-1", scope="VEHICLE", vehicle_ids=["van-2"])

        result = solve(request(employees=[driver, TECHNICIAN], vehicles=vans, locks=[lock]))

        assert [v.vehicle_id for v in result.assignments[0].vehicles] == ["van-2"]


class TestSoftPreferences:
    def test_keeps_an_existing_crew_when_the_alternatives_are_equal(self):
        pool = [
            SUPERVISOR,
            employee(id="sup-2", is_pms_grade=True),
            TECHNICIAN,
            employee(id="tech-2"),
        ]
        existing = ExistingAssignmentInput(visit_id="visit-1", employee_ids=["sup-2", "tech-2"])

        result = solve(request(employees=pool, existing=[existing]))

        assert result.assignments[0].employee_ids == ["sup-2", "tech-2"]

    def test_never_drops_a_visit_to_keep_the_board_tidy(self):
        # Staffing must outrank every preference put together: the existing
        # proposal cannot be honoured and the visit staffed at the same time,
        # so the visit wins.
        pool = [SUPERVISOR, TECHNICIAN]
        existing = ExistingAssignmentInput(visit_id="visit-1", employee_ids=["ghost-1", "ghost-2"])

        result = solve(request(employees=pool, existing=[existing]))

        assert len(result.assignments) == 1

    def test_spreads_work_rather_than_loading_one_person(self):
        # Two non-overlapping visits, two supervisors, two technicians. A
        # solver with no balance term would happily use one pair twice.
        visits = [
            visit(id="v-1", window_start_minute=8 * 60, duration_minutes=60),
            visit(id="v-2", window_start_minute=13 * 60, duration_minutes=60),
        ]
        pool = [
            SUPERVISOR,
            employee(id="sup-2", is_pms_grade=True),
            TECHNICIAN,
            employee(id="tech-2"),
        ]

        result = solve(request(visits=visits, employees=pool))

        assert len(result.assignments) == 2
        counts: dict[str, int] = {}
        for assignment in result.assignments:
            for employee_id in assignment.employee_ids:
                counts[employee_id] = counts.get(employee_id, 0) + 1
        assert max(counts.values()) == 1


class TestDeterminism:
    def test_identical_requests_give_identical_schedules(self):
        pool = [
            SUPERVISOR,
            employee(id="sup-2", is_pms_grade=True),
            TECHNICIAN,
            employee(id="tech-2"),
        ]
        payload = request(employees=pool)

        first = solve(payload)
        second = solve(payload)

        assert first.model_dump(exclude={"solve_seconds"}) == second.model_dump(
            exclude={"solve_seconds"}
        )

    def test_the_order_employees_arrive_in_does_not_change_the_answer(self):
        pool = [SUPERVISOR, TECHNICIAN, employee(id="tech-2")]

        forwards = solve(request(employees=pool))
        backwards = solve(request(employees=list(reversed(pool))))

        assert forwards.assignments[0].employee_ids == backwards.assignments[0].employee_ids


class TestImpossibleSchedule:
    def test_reports_every_visit_when_nothing_can_be_staffed(self):
        visits = [visit(id="v-1"), visit(id="v-2", window_start_minute=13 * 60)]

        result = solve(request(visits=visits, employees=[]))

        assert result.assignments == []
        assert len(result.unassigned) == 2
        assert all(u.message for u in result.unassigned)

    def test_one_impossible_visit_does_not_cost_the_others(self):
        possible = visit(id="v-ok", window_start_minute=8 * 60, duration_minutes=60)
        impossible = visit(
            id="v-bad",
            window_start_minute=13 * 60,
            window_end_minute=13 * 60 + 30,
            duration_minutes=300,
        )

        result = solve(request(visits=[possible, impossible]))

        assert [a.visit_id for a in result.assignments] == ["v-ok"]
        assert [u.visit_id for u in result.unassigned] == ["v-bad"]


@pytest.mark.parametrize("crew_size", [1, 2, 3])
def test_meets_the_crew_size_the_agreement_asks_for(crew_size):
    pool = [SUPERVISOR] + [employee(id=f"t-{i}") for i in range(4)]

    result = solve(request(visits=[visit(required_crew_size=crew_size)], employees=pool))

    assert len(result.assignments[0].employee_ids) == crew_size


class TestVehicleAuthorization:
    """The clarified rule (ULK-C09), case by case.

    A checkmark means "may drive". Every checked employee is equal: there is no
    owner, no primary driver, no ranking. These cases are shaped after the real
    fleet — DAC-2485 and DAG-3284 carry three checked drivers each, DAI-0191
    two, PJ-6796 two, and some vans carry exactly one — because the bug this
    guards against is a model that quietly picks a "main" driver and then
    reports the vehicle unusable whenever that one person is busy.
    """

    def _crew_of_three(self) -> list[EmployeeInput]:
        return [
            employee(id="driver-a", is_pms_grade=True, authorized_vehicle_ids=["van-1"]),
            employee(id="driver-b", authorized_vehicle_ids=["van-1"]),
            employee(id="driver-c", authorized_vehicle_ids=["van-1"]),
        ]

    def test_any_checked_employee_may_be_the_driver(self):
        # Each of the three, alone with a supervisor, must be able to drive it.
        for candidate in ("driver-a", "driver-b", "driver-c"):
            crew = [
                employee(id="sup-x", is_pms_grade=True),
                employee(id=candidate, authorized_vehicle_ids=["van-1"]),
            ]
            result = solve(
                request(
                    employees=crew,
                    vehicles=[VehicleInput(id="van-1", seat_capacity=4)],
                )
            )

            assert len(result.assignments) == 1, candidate
            vehicles = result.assignments[0].vehicles
            assert len(vehicles) == 1, candidate
            assert vehicles[0].driver_employee_id == candidate

    def test_the_driver_is_always_someone_on_the_crew(self):
        result = solve(
            request(
                employees=self._crew_of_three(),
                vehicles=[VehicleInput(id="van-1", seat_capacity=4)],
            )
        )

        assignment = result.assignments[0]
        driver = assignment.vehicles[0].driver_employee_id
        assert driver in assignment.employee_ids

    def test_an_unchecked_employee_is_never_the_driver(self):
        result = solve(
            request(
                employees=[
                    employee(id="sup-1", is_pms_grade=True, authorized_vehicle_ids=["van-1"]),
                    # Checked for nothing. Must never be recorded as driving.
                    employee(id="unchecked-1"),
                ],
                vehicles=[VehicleInput(id="van-1", seat_capacity=4)],
            )
        )

        for assignment in result.assignments:
            for vehicle in assignment.vehicles:
                assert vehicle.driver_employee_id != "unchecked-1"

    def test_a_multi_driver_vehicle_survives_one_driver_being_unavailable(self):
        # The point of the rule: three checked drivers, one away, van still goes.
        crew = self._crew_of_three()
        crew[1] = employee(
            id="driver-b",
            authorized_vehicle_ids=["van-1"],
            unavailable_dates=["2026-09-09"],
        )

        result = solve(
            request(employees=crew, vehicles=[VehicleInput(id="van-1", seat_capacity=4)])
        )

        assert len(result.assignments) == 1
        vehicles = result.assignments[0].vehicles
        assert len(vehicles) == 1
        assert vehicles[0].driver_employee_id != "driver-b"

    def test_a_single_driver_vehicle_is_unusable_when_that_driver_cannot_serve(self):
        result = solve(
            request(
                employees=[
                    employee(id="sup-1", is_pms_grade=True),
                    employee(
                        id="only-driver",
                        authorized_vehicle_ids=["van-1"],
                        unavailable_dates=["2026-09-09"],
                    ),
                    employee(id="tech-9"),
                ],
                vehicles=[VehicleInput(id="van-1", seat_capacity=4)],
            )
        )

        # Staffed by the two who can serve, but no vehicle: nobody left is checked.
        for assignment in result.assignments:
            assert assignment.vehicles == []

    def test_says_so_when_nobody_eligible_is_checked_for_any_vehicle(self):
        result = solve(
            request(
                employees=[
                    employee(id="sup-1", is_pms_grade=True),
                    # Crew of 2 required, only one person: the visit is unassigned,
                    # and the missing driver is one of the reasons it names.
                    employee(
                        id="driver-away",
                        authorized_vehicle_ids=["van-1"],
                        unavailable_dates=["2026-09-09"],
                    ),
                ],
                vehicles=[VehicleInput(id="van-1", seat_capacity=4)],
            )
        )

        assert result.unassigned
        assert "NO_AUTHORIZED_DRIVER" in result.unassigned[0].reason_codes

    def test_a_branch_vehicle_stays_in_its_branch(self):
        result = solve(
            request(
                employees=[
                    employee(id="sup-1", is_pms_grade=True, authorized_vehicle_ids=["kandy-van"]),
                    employee(id="tech-1", authorized_vehicle_ids=["kandy-van"]),
                ],
                vehicles=[VehicleInput(id="kandy-van", branch_code="KANDY", seat_capacity=4)],
            )
        )

        for assignment in result.assignments:
            assert assignment.vehicles == []

    def test_a_vehicle_too_small_for_the_crew_is_not_used(self):
        result = solve(
            request(
                employees=self._crew_of_three(),
                vehicles=[VehicleInput(id="van-1", seat_capacity=1)],
            )
        )

        for assignment in result.assignments:
            assert assignment.vehicles == []

    def test_one_vehicle_cannot_be_in_two_places_at_once(self):
        # Two visits at the same hour, three checked drivers between them.
        result = solve(
            request(
                visits=[
                    visit(id="visit-a"),
                    visit(id="visit-b", service_site_id="site-2"),
                ],
                employees=[
                    employee(id="sup-1", is_pms_grade=True, authorized_vehicle_ids=["van-1"]),
                    employee(id="sup-2", is_pms_grade=True, authorized_vehicle_ids=["van-1"]),
                    employee(id="tech-1", authorized_vehicle_ids=["van-1"]),
                    employee(id="tech-2", authorized_vehicle_ids=["van-1"]),
                ],
                vehicles=[VehicleInput(id="van-1", seat_capacity=4)],
            )
        )

        using_the_van = [
            assignment
            for assignment in result.assignments
            if any(vehicle.vehicle_id == "van-1" for vehicle in assignment.vehicles)
        ]
        assert len(using_the_van) <= 1
