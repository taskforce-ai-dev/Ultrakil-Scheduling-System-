"""The /solve endpoint.

The model itself is covered in test_solver.py; these check the wire contract —
that a real payload round-trips, and that the endpoint stays reproducible,
which is the promise the API depends on when a manager reruns a schedule.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

PAYLOAD = {
    "run_id": "run-1",
    "visits": [
        {
            "id": "visit-1",
            "branch_code": "COLOMBO",
            "visit_date": "2026-09-09",
            "window_start_minute": 540,
            "window_end_minute": 1020,
            "duration_minutes": 90,
            "required_crew_size": 2,
            "required_skill_codes": [],
            "service_site_id": "site-1",
            "is_preferred_day": True,
        }
    ],
    "employees": [
        {"id": "sup-1", "branch_code": "COLOMBO", "is_pms_grade": True},
        {"id": "tech-1", "branch_code": "COLOMBO"},
    ],
    "vehicles": [],
    "locks": [],
    "existing": [],
    "time_limit_seconds": 5.0,
}


def test_solves_a_real_payload():
    response = client.post("/solve", json=PAYLOAD)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] in ("OPTIMAL", "FEASIBLE")
    assert body["assignments"][0]["employee_ids"] == ["sup-1", "tech-1"]
    assert body["unassigned"] == []
    assert body["visits_considered"] == 1


def test_is_reproducible_across_calls():
    first = client.post("/solve", json=PAYLOAD).json()
    second = client.post("/solve", json=PAYLOAD).json()

    first.pop("solve_seconds")
    second.pop("solve_seconds")
    assert first == second


def test_reports_an_unstaffable_visit_rather_than_failing():
    payload = {**PAYLOAD, "employees": []}

    response = client.post("/solve", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["assignments"] == []
    assert body["unassigned"][0]["visit_id"] == "visit-1"
    assert body["unassigned"][0]["message"]


def test_rejects_a_malformed_request():
    response = client.post("/solve", json={"run_id": "x"})

    assert response.status_code == 422
