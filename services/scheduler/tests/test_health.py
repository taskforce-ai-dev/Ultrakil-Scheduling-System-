from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_liveness_returns_ok():
    response = client.get("/health/live")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "ultrakil-scheduler"
    assert body["uptime_seconds"] >= 0


def test_readiness_returns_ok():
    response = client.get("/health/ready")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_unknown_route_is_404():
    assert client.get("/does-not-exist").status_code == 404
