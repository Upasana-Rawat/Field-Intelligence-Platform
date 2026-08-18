# Field Intelligence Platform — V2.1

Map-first field intelligence application for discovering nearby properties, sharing team knowledge, planning field visits, and capturing visits through voice or text.

## Structure

- `api.py` — FastAPI application and API routes
- `db.py` — SQLite/PostgreSQL database layer and seed loading
- `discover.py` — Google Places discovery with OSM/Overpass fallback
- `tools.py` — deterministic search, distance, history, overlap and follow-up logic
- `agent.py` — controlled AI field copilot
- `extract.py` — voice/text field-note extraction
- `geo.py` — geocoding/location helpers
- `llm.py` — Gemini model resolution/calls
- `aliases.py` — naming/alias helpers
- `static/` — full-screen SPA frontend
- `data/synthetic_field_visits_110_records.csv` — synthetic demo seed data used for initial seeding when the database is empty

## Local run

1. Create a Python 3.11+ environment.
2. Install dependencies:

   `pip install -r requirements.txt`

3. Copy `.env.example` to `.env` and provide keys as needed. Do not commit `.env`.
4. For a local single-user test, `DATABASE_URL` can be omitted; SQLite will be created automatically.
5. Start:

   `uvicorn api:app --reload --port 8000`

6. Open `http://localhost:8000`.

## Production

Use PostgreSQL for shared multi-user persistence. Set `DATABASE_URL`, `GOOGLE_MAPS_API_KEY`, and `GEMINI_API_KEY` in the hosting platform's environment settings. Do not put secrets in source files or GitHub.

The Dockerfile starts FastAPI with the platform `PORT` variable.

## Important

The CSV is seed data, not the production database. The application only seeds when the target database has no properties, so subsequent deployments do not wipe live visits.
