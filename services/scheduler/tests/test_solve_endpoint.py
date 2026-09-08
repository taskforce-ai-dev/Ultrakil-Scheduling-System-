"""The /solve endpoint.

The model itself is covered in test_solver.py; these check the wire contract —
that a real payload round-trips, and that the endpoint stays reproducible,
which is the promise the API depends on when a manager reruns a schedule.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.settings import Settings, settings

client = TestClient(app)


@pytest.fixture(autouse=True)
def private_local_runtime(monkeypatch):
    """Existing wire tests model the explicitly opted-in private runtime."""
    monkeypatch.setattr(settings, "api_token", None)
    monkeypatch.setattr(settings, "allow_unauthenticated", True)


def test_unauthenticated_mode_defaults_to_disabled(monkeypatch):
    monkeypatch.delenv("SCHEDULER_ALLOW_UNAUTHENTICATED", raising=False)

    assert Settings().allow_unauthenticated is False

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


def test_requires_the_configured_service_token(monkeypatch):
    monkeypatch.setattr(settings, "api_token", "scheduler-token")

    unauthorized = client.post("/solve", json=PAYLOAD)
    authorized = client.post(
        "/solve", json=PAYLOAD, headers={"Authorization": "Bearer scheduler-token"}
    )

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200


def test_allows_local_solves_when_no_service_token_is_configured(monkeypatch):
    monkeypatch.setattr(settings, "api_token", None)
    monkeypatch.setattr(settings, "allow_unauthenticated", True)

    response = client.post("/solve", json=PAYLOAD)

    assert response.status_code == 200


def test_rejects_solves_by_default_when_token_is_missing(monkeypatch):
    monkeypatch.setattr(settings, "api_token", None)
    monkeypatch.setattr(settings, "allow_unauthenticated", False)

    response = client.post("/solve", json=PAYLOAD)

    assert response.status_code == 503
