# Local setup

Getting the whole UltraKIL stack running on your own machine, and seeing a live
preview in the browser. Written for Windows, with notes for macOS and Linux.

---

## 1. Install the prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| [Git](https://git-scm.com/downloads) | any recent | Git Bash on Windows is a comfortable shell for these commands |
| [Node.js](https://nodejs.org/) | **22 LTS** | `node -v` should print `v22.x` |
| pnpm | **10** | `npm install -g pnpm` |
| [Python](https://www.python.org/downloads/) | **3.11** | Tick *"Add Python to PATH"* in the Windows installer |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | latest | Must be **running** before `pnpm dev:infra` |

Verify everything at once:

```bash
node -v && pnpm -v && python --version && docker -v
```

---

## 2. Clone the repository

```bash
git clone https://github.com/taskforce-ai-dev/Ultrakil-Scheduling-System-.git
cd Ultrakil-Scheduling-System-
```

> **Windows:** clone somewhere short and without spaces, such as
> `C:\dev\ultrakil`. Long paths under `Desktop\...` occasionally break Node
> tooling, and spaces in a path confuse some scripts.

---

## 3. Create your environment file

```bash
cp .env.example .env        # Windows CMD: copy .env.example .env
```

The defaults work as-is with Docker. Only edit it if port 5432, 6379, 3000, 3001
or 8000 is already used on your machine.

**`.env` is git-ignored and must never be committed.** CI fails any pull request
that tracks one.

---

## 4. Install dependencies

```bash
pnpm install
```

This installs every workspace package (`apps/*`, `packages/*`) in one go.

For the Python scheduling service:

```bash
cd services/scheduler
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt -r requirements-dev.txt
cd ../..
```

---

## 5. Start the infrastructure

Docker Desktop must be running first.

```bash
pnpm dev:infra
```

This starts PostgreSQL on `5432` and Redis on `6379`. Confirm both are healthy:

```bash
docker compose ps
```

Stop them later with `pnpm dev:infra:down`. Your data survives a restart; use
`docker compose down -v` if you deliberately want a clean database.

---

## 6. Create the database schema

```bash
pnpm db:migrate
```

Then load reference data and the workforce matrix:

```bash
pnpm db:seed
```

The seed needs the technician matrix workbook. See [`../data/README.md`](../data/README.md)
— in short, drop `technician-matrix.xlsx` into `data/`. If it is missing the seed
still succeeds; it loads the branches and skips the workforce import with a warning,
so you are never blocked waiting for the file.

---

## 7. Run the services

Open a terminal per service.

```bash
pnpm dev:api            # NestJS API   -> http://localhost:3001/api
pnpm dev:scheduler      # Python       -> http://localhost:8000
```

Once ULK-O01 lands, the manager portal runs alongside them:

```bash
pnpm --filter @ultrakil/manager-web dev    # -> http://localhost:3000
```

---

## 8. Confirm it works

Open these in your browser:

| Check | URL | Expected |
| --- | --- | --- |
| API is alive | http://localhost:3001/api/health/live | `{"status":"ok",...}` |
| All dependencies are up | http://localhost:3001/api/health/ready | `{"status":"ok",...}` with `database`, `queue` and `scheduler` all `"up"` |
| Interactive API docs | http://localhost:3001/api/docs | Swagger UI listing every endpoint |
| Shared vocabulary | http://localhost:3001/api/meta | Branch codes, weekdays, PMS grades, error codes |
| Scheduling service | http://localhost:8000/docs | FastAPI docs |

`/health/ready` returns **HTTP 503** when something is down, and the body names
which dependency and how to fix it. That is the fastest way to diagnose a broken
local environment.

---

## Running on a machine with limited RAM

Docker is used for **two containers only** — PostgreSQL and Redis. `pnpm dev:infra`
starts exactly those; the scheduler service is not containerised for development,
it runs natively with `pnpm dev:scheduler`.

Both containers are tuned down in `docker-compose.yml` rather than left on
their defaults, which assume a server:

| Container | Memory cap | Notes |
| --- | --- | --- |
| `postgres` | 384 MB | 20 connections, 64 MB shared buffers |
| `redis` | 128 MB | 96 MB max data, `noeviction` |

Together they idle at roughly **150–200 MB**. The larger cost on Windows is not
the containers — it is the WSL2 virtual machine Docker Desktop runs them in,
which will grow to consume half your RAM unless you cap it.

### Cap WSL2 memory (the setting that actually matters)

Create `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
memory=3GB
processors=2
swap=2GB
```

Then apply it from PowerShell:

```powershell
wsl --shutdown
```

Restart Docker Desktop. 3 GB is comfortable for both containers with room to
spare; drop to 2 GB if you need to, and raise it if PostgreSQL starts refusing
connections.

### Trim Docker Desktop itself

In **Settings**:

- **General** → untick *Start Docker Desktop when you log in* (start it only when working)
- **Kubernetes** → confirm it is **off** (it is by default; it costs ~1 GB if on)
- **Extensions** → untick *Enable Docker Extensions*

### Free memory while working

- Stop the containers when you finish for the day: `pnpm dev:infra:down`
- Quit Docker Desktop entirely when not developing
- You do not need every service running at once. Working on the API alone?
  Skip `pnpm dev:scheduler` — `/api/health/ready` will report `scheduler: down`,
  which is correct and harmless.

### If Docker still will not fit

Install PostgreSQL 16 natively from postgresql.org and Redis via
[Memurai](https://www.memurai.com/) (Redis has no official Windows build), then
point `DATABASE_URL`, `REDIS_HOST` and `REDIS_PORT` in your `.env` at them.
This uses less memory than Docker Desktop, at the cost of more setup and a
higher chance that your machine and the server behave differently.

---

## Common problems

**`pnpm dev:infra` fails with "Cannot connect to the Docker daemon"**
Docker Desktop is not running. Start it and wait for the whale icon to settle.

**`Port 5432 is already allocated`**
Another PostgreSQL is installed locally. Either stop that service, or change
`POSTGRES_PORT` in `.env` to `5433` and update the port inside `DATABASE_URL` to match.

**`Environment variable not found: DATABASE_URL`**
You have not created `.env`, or you are running the command from inside
`apps/api` with no `.env` above it. Run pnpm scripts from the repository root.

**`/health/ready` shows `scheduler: down`**
The Python service is not running. Start it with `pnpm dev:scheduler`. The API
itself still works — the readiness check is telling you the truth about a
dependency, not reporting a bug.

**`pnpm: command not found`**
Run `npm install -g pnpm`, then reopen the terminal.

**Prisma complains that the client is out of date**
Run `pnpm --filter @ultrakil/api prisma:generate`.

---

## Everyday commands

| Command | What it does |
| --- | --- |
| `pnpm dev:infra` / `pnpm dev:infra:down` | Start / stop PostgreSQL and Redis |
| `pnpm dev:api` | API in watch mode |
| `pnpm dev:scheduler` | Scheduling service in reload mode |
| `pnpm db:migrate` | Apply new migrations |
| `pnpm db:reset` | Drop, recreate, migrate and re-seed — wipes local data |
| `pnpm db:seed` | Re-run the seed and matrix import (safe to repeat) |
| `pnpm test` | Unit tests |
| `pnpm contracts:generate` | Regenerate the OpenAPI contract and TS client |
| `pnpm lint` / `pnpm typecheck` | The same checks CI runs |
