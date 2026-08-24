# `services/scheduler` — UltraKIL scheduling service

**Owner: Chanya (@cha-she).**

Python / FastAPI service that will solve the crew-and-vehicle assignment problem.
Phase 1 ships the service, its health endpoints and its deployment; the
constraint model lands with **ULK-C06**.

## Run it locally

```bash
cd services/scheduler

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -r requirements.txt -r requirements-dev.txt

uvicorn app.main:app --reload --port 8000
```

From the repository root, `pnpm dev:scheduler` does the same thing.

| Endpoint | Purpose |
| --- | --- |
| http://localhost:8000/health/live | Liveness — 200 while the process runs |
| http://localhost:8000/health/ready | Readiness — polled by the API's `/api/health/ready` |
| http://localhost:8000/docs | Interactive FastAPI documentation |

## Tests and lint

```bash
pytest -q
ruff check .
```

## In Docker

`docker compose up scheduler` builds and runs it from this directory's Dockerfile.
