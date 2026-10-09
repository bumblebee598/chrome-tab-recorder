from fastapi.testclient import TestClient

from app.api.main import app as api_app
from app.worker.main import app as worker_app


def test_api_health() -> None:
    response = TestClient(api_app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "api"}


def test_worker_health() -> None:
    response = TestClient(worker_app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "worker"}


def test_healthz_alias_still_serves_local_tooling() -> None:
    assert TestClient(api_app).get("/healthz").status_code == 200
