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
    CandidateSlot,
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
    # The default person can get themselves to site, so tests about other rules
    # are not derailed by a travel constraint they never meant to exercise.
    base = dict(
        id="emp-1",
        branch_code="COLOMBO",
        is_pms_grade=False,
        can_use_public_transport=True,
    )
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

    def test_explains_when_an_authorized_vehicle_cannot_fit_the_crew(self):
        bike = VehicleInput(id="bike-1", branch_code="COLOMBO", seat_capacity=1)
        driver = employee(
            id="sup-1",
            is_pms_grade=True,
            authorized_vehicle_ids=["bike-1"],
            can_use_public_transport=False,
        )
        technician = employee(id="tech-1", can_use_public_transport=False)

        result = solve(request(employees=[driver, technician], vehicles=[bike]))

        assert result.assignments == []
        assert "CREW_CANNOT_TRAVEL" in result.unassigned[0].reason_codes
        assert "NO_AUTHORIZED_DRIVER" not in result.unassigned[0].reason_codes

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


class TestOneVehiclePerVisit:
    """A crew travels together, so a visit takes one vehicle at most.

    Without a cap every assigned vehicle earned WEIGHT_VEHICLE_ASSIGNED, so the
    model parked the whole free fleet on one job for the points.
    """

    DRIVER = employee(
        id="sup-1",
        is_pms_grade=True,
        can_use_public_transport=True,
        authorized_vehicle_ids=["veh-1", "veh-2", "veh-3"],
    )
    MATE = employee(
        id="tech-1",
        can_use_public_transport=True,
        authorized_vehicle_ids=["veh-1", "veh-2", "veh-3"],
    )
    FLEET = [
        VehicleInput(id="veh-1", branch_code="COLOMBO", seat_capacity=4),
        VehicleInput(id="veh-2", branch_code="COLOMBO", seat_capacity=4),
        VehicleInput(id="veh-3", branch_code="COLOMBO", seat_capacity=4),
    ]

    def test_takes_one_vehicle_when_the_whole_fleet_is_free(self):
        result = solve(
            request(employees=[self.DRIVER, self.MATE], vehicles=self.FLEET)
        )

        assert len(result.assignments) == 1
        assert len(result.assignments[0].vehicles) == 1

    def test_leaves_the_other_vehicles_for_other_visits(self):
        result = solve(
            request(
                visits=[
                    visit(id="v-1"),
                    visit(id="v-2", service_agreement_id="agr-2"),
                    visit(id="v-3", service_agreement_id="agr-3"),
                ],
                employees=[
                    self.DRIVER,
                    self.MATE,
                    employee(
                        id="sup-2",
                        is_pms_grade=True,
                        can_use_public_transport=True,
                        authorized_vehicle_ids=["veh-2"],
                    ),
                    employee(
                        id="tech-2",
                        can_use_public_transport=True,
                        authorized_vehicle_ids=["veh-2"],
                    ),
                ],
                vehicles=self.FLEET,
            )
        )

        # Guard against a vacuous pass: the point is that work got staffed
        # *and* no visit hoarded the fleet.
        assert len(result.assignments) >= 2
        for assignment in result.assignments:
            assert len(assignment.vehicles) <= 1
        taken = [v.vehicle_id for a in result.assignments for v in a.vehicles]
        assert len(taken) == len(set(taken))


class TestGettingToSite:
    """A crew with no vehicle travels by public transport — all of them.

    One colleague's checkmark is transport for that colleague and nobody else,
    so a single ticked crew member cannot carry the rest of the crew.
    """

    WALKER = employee(id="sup-1", is_pms_grade=True, can_use_public_transport=True)
    STRANDED = employee(id="tech-2", can_use_public_transport=False)

    def test_will_not_send_someone_who_cannot_get_there_without_a_vehicle(self):
        result = solve(
            request(employees=[self.WALKER, self.STRANDED], vehicles=[])
        )

        assert result.assignments == []
        assert [u.visit_id for u in result.unassigned] == ["visit-1"]

    def test_one_crew_member_with_public_transport_does_not_carry_the_others(self):
        # Exactly the case UltraKIL asked about: one tick, one blank.
        result = solve(
            request(employees=[self.WALKER, self.STRANDED], vehicles=[])
        )

        assert result.assignments == []

    def test_staffs_the_same_crew_once_a_vehicle_is_available(self):
        result = solve(
            request(
                employees=[
                    employee(
                        id="sup-1",
                        is_pms_grade=True,
                        can_use_public_transport=True,
                        authorized_vehicle_ids=["veh-1"],
                    ),
                    self.STRANDED,
                ],
                vehicles=[VehicleInput(id="veh-1", branch_code="COLOMBO", seat_capacity=4)],
            )
        )

        assert len(result.assignments) == 1
        assert [v.vehicle_id for v in result.assignments[0].vehicles] == ["veh-1"]
        assert sorted(result.assignments[0].employee_ids) == ["sup-1", "tech-2"]

    def test_staffs_without_a_vehicle_when_everybody_can_travel(self):
        result = solve(request(vehicles=[]))

        assert len(result.assignments) == 1
        assert result.assignments[0].vehicles == []

    def test_explains_why_rather_than_leaving_it_blank(self):
        result = solve(
            request(employees=[self.WALKER, self.STRANDED], vehicles=[])
        )

        entry = result.unassigned[0]
        assert "CREW_CANNOT_TRAVEL" in entry.reason_codes
        assert "public transport" in entry.reason_messages["CREW_CANNOT_TRAVEL"]


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


def slot(date: str, *, preferred: bool = False, opens: int = 9 * 60, closes: int = 17 * 60):
    """One legal day, from opening to the last start that still fits the job."""
    return CandidateSlot(
        date=date,
        earliest_start_minute=opens,
        latest_start_minute=closes - 90,
        is_preferred=preferred,
    )


class TestChoosingTheDayAndTime:
    """Date, time, crew and vehicle decided in one solve.

    Before this, generation fixed the date and the solver could only pick people
    to fit around it, so a Tuesday visit with no free supervisor stayed
    unstaffed even when Thursday was empty. Every case here would fail against
    that model — which is the point of them.
    """

    def test_moves_a_visit_to_a_day_its_crew_can_actually_work(self):
        # Tuesday is the generated date and the whole crew is away. Thursday is
        # equally allowed and everyone is free. The old model left this
        # unstaffed; the new one moves it.
        away = ["2026-09-08"]
        result = solve(
            request(
                visits=[
                    visit(
                        visit_date="2026-09-08",
                        candidate_slots=[slot("2026-09-08"), slot("2026-09-10")],
                    )
                ],
                employees=[
                    employee(id="sup-1", is_pms_grade=True, unavailable_dates=away),
                    employee(id="tech-1", unavailable_dates=away),
                ],
            )
        )

        assert len(result.assignments) == 1
        assert result.assignments[0].scheduled_date == "2026-09-10"

    def test_spreads_two_visits_across_days_rather_than_dropping_one(self):
        # One crew, two visits, both generated on the same Tuesday, each long
        # enough that only one fits in a day. Fixed dates meant one had to go
        # unstaffed. Two allowed days means both happen.
        slots = [slot("2026-09-08"), slot("2026-09-10")]
        result = solve(
            request(
                visits=[
                    visit(
                        id="visit-a",
                        visit_date="2026-09-08",
                        duration_minutes=7 * 60,
                        candidate_slots=slots,
                    ),
                    visit(
                        id="visit-b",
                        visit_date="2026-09-08",
                        service_site_id="site-2",
                        duration_minutes=7 * 60,
                        candidate_slots=slots,
                    ),
                ],
                employees=[
                    employee(id="sup-1", is_pms_grade=True),
                    employee(id="tech-1"),
                ],
            )
        )

        assert len(result.assignments) == 2
        assert {a.scheduled_date for a in result.assignments} == {"2026-09-08", "2026-09-10"}

    def test_uses_the_same_day_twice_when_the_hours_allow_it(self):
        # Not a rule that one visit per day is the answer: a long enough window
        # takes both, one after the other, and that is the better schedule
        # because it leaves Thursday free.
        result = solve(
            request(
                visits=[
                    visit(id="visit-a", duration_minutes=60, candidate_slots=[slot("2026-09-08")]),
                    visit(
                        id="visit-b",
                        duration_minutes=60,
                        service_site_id="site-2",
                        candidate_slots=[slot("2026-09-08")],
                    ),
                ],
                employees=[
                    employee(id="sup-1", is_pms_grade=True),
                    employee(id="tech-1"),
                ],
            )
        )

        assert len(result.assignments) == 2
        starts = sorted(a.start_minute for a in result.assignments)
        # Same crew, so the second cannot begin before the first has finished.
        assert starts[1] - starts[0] >= 60

    def test_start_times_land_on_the_half_hour(self):
        result = solve(
            request(
                visits=[visit(candidate_slots=[slot("2026-09-08", opens=9 * 60)])],
            )
        )

        assert result.assignments
        assert result.assignments[0].start_minute % 30 == 0

    def test_prefers_the_customers_weekday_when_it_costs_nothing(self):
        result = solve(
            request(
                visits=[
                    visit(
                        visit_date="2026-09-08",
                        candidate_slots=[
                            slot("2026-09-08"),
                            slot("2026-09-10", preferred=True),
                        ],
                    )
                ],
            )
        )

        assert result.assignments[0].scheduled_date == "2026-09-10"

    def test_covers_more_work_rather_than_honouring_a_preferred_day(self):
        # The trade-off that matters. One crew; visit A can only happen Tuesday,
        # visit B prefers Tuesday but is allowed Thursday. Staffing both is
        # worth 10,000 and the preference 30, so B moves.
        result = solve(
            request(
                visits=[
                    visit(id="only-tuesday", candidate_slots=[slot("2026-09-08")]),
                    visit(
                        id="prefers-tuesday",
                        service_site_id="site-2",
                        duration_minutes=8 * 60,
                        candidate_slots=[
                            slot("2026-09-08", preferred=True, closes=17 * 60),
                            slot("2026-09-10", closes=17 * 60),
                        ],
                    ),
                ],
                employees=[
                    employee(id="sup-1", is_pms_grade=True),
                    employee(id="tech-1"),
                ],
            )
        )

        assert len(result.assignments) == 2

    def test_a_visit_with_no_candidates_stays_exactly_where_it_is(self):
        # What a published or time-locked visit sends. Freedom is opt-in.
        result = solve(request(visits=[visit(visit_date="2026-09-09")]))

        assert result.assignments[0].scheduled_date == "2026-09-09"
        assert result.assignments[0].start_minute == 9 * 60

    def test_never_places_a_visit_outside_the_hours_it_was_given(self):
        result = solve(
            request(
                visits=[
                    visit(
                        duration_minutes=90,
                        candidate_slots=[slot("2026-09-08", opens=13 * 60, closes=16 * 60)],
                    )
                ],
            )
        )

        start = result.assignments[0].start_minute
        assert 13 * 60 <= start <= 16 * 60 - 90

    def test_is_still_deterministic_when_it_may_choose_the_day(self):
        def run():
            return solve(
                request(
                    visits=[
                        visit(
                            id=f"visit-{n}",
                            service_site_id=f"site-{n}",
                            candidate_slots=[slot("2026-09-08"), slot("2026-09-10")],
                        )
                        for n in range(4)
                    ],
                    employees=[
                        employee(id="sup-1", is_pms_grade=True),
                        employee(id="sup-2", is_pms_grade=True),
                        employee(id="tech-1"),
                        employee(id="tech-2"),
                    ],
                )
            )

        first, second = run(), run()
        assert [(a.visit_id, a.scheduled_date, a.start_minute) for a in first.assignments] == [
            (a.visit_id, a.scheduled_date, a.start_minute) for a in second.assignments
        ]
