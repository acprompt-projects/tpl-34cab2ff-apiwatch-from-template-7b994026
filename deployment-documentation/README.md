# APIWatch — Lightweight API Health Monitor

APIWatch pings your endpoints on a configurable schedule, records response time and status history in SQLite, exposes a REST API for queries, and renders a simple dashboard.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  APIWatch Server                 │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │ Scheduler │  │ REST API │  │   Dashboard   │ │
│  │ (ping    │──│ (FastAPI)│──│  (static HTML) │ │
│  │  engine) │  │          │  │               │ │
│  └─────┬────┘  └────┬─────┘  └───────────────┘ │
│        │            │                           │
│        ▼            ▼                           │
│  ┌──────────────────────────┐                   │
│  │     SQLite Database      │                   │
│  └──────────────────────────┘                   │
└─────────────────────────────────────────────────┘
         ▲
         │ HTTP/HTTPS pings
─────────┴────────────────────────────
   External Endpoints
```

- **Scheduler** — APScheduler runs periodic HTTP checks per endpoint.
- **REST API** — FastAPI serves JSON endpoints under `/api/`.
- **Dashboard** — Served at `/`, built with vanilla JS + fetch.
- **Database** — SQLite file stored on a persistent volume.

## Quick Start

```bash
# Clone and enter the project
git clone https://github.com/your-org/tpl-34cab2ff-apiwatch.git
cd tpl-34cab2ff-apiwatch

# Copy example config and edit
cp config.example.yaml config.yaml

# Start the service
docker compose -f deployment-documentation/docker-compose.yml up -d

# Open dashboard
open http://localhost:8000
```

## Configuration (`config.yaml`)

```yaml
# config.example.yaml
endpoints:
  - name: Google
    url: https://www.google.com
    method: GET
    interval_seconds: 60
    timeout_seconds: 10
    expected_status: 200
    headers: {}

  - name: API JSONPlaceholder
    url: https://jsonplaceholder.typicode.com/posts/1
    method: GET
    interval_seconds: 120
    timeout_seconds: 5
    expected_status: 200

scheduler:
  max_concurrent: 5

server:
  host: "0.0.0.0"
  port: 8000
```

| Field | Description |
|---|---|
| `name` | Display label for the endpoint |
| `url` | Full URL to ping |
| `method` | HTTP method (GET, HEAD, POST, etc.) |
| `interval_seconds` | Time between checks |
| `timeout_seconds` | Request timeout |
| `expected_status` | Status code considered healthy |

## REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health check |
| GET | `/api/endpoints` | List all configured endpoints |
| GET | `/api/endpoints/{name}/checks` | Recent check history (query: `?limit=50`) |
| GET | `/api/endpoints/{name}/stats` | Uptime %, avg response time, last 24h |
| POST | `/api/endpoints/{name}/check` | Trigger an on-demand check |

## Development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install pytest pytest-asyncio httpx
pytest -q
```

## CI

GitHub Actions runs lint (ruff), tests (pytest), and Docker build on every push — see `.github/workflows/ci.yml`.

## License

MIT