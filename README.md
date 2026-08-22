# Field Intelligence Platform

A field-sales intelligence web application for discovery, territory planning, visit capture, shared property intelligence and AI-assisted field work.

## Demo data
This public-safe build uses synthetic data only:

- 75 unique properties
- 110 field visits
- 4 reps: Rep A, Rep B, Rep C, Rep D
- 12 intentional cross-rep overlap visits
- Synthetic contact names, emails and phone numbers

## Business logic
A property is not automatically owned because a rep discovered or visited it.

- **Open:** no meaningful visit yet.
- **No Requirement:** checked by a rep, no current business requirement; no ownership, but the result and contact intelligence are shared with the team so another rep does not waste a physical visit.
- **Opportunity:** a genuine business opportunity exists; the property is owned by the engaging rep.
- **Follow-up:** an active business conversation is in progress; the property remains with the responsible rep.
- **Overlap:** another rep may still independently encounter a property; the system preserves both visits and does not silently transfer ownership.

## Contact intelligence
Each property can retain reusable contact information:
name, designation, email, phone, exact location and field remarks. This remains useful even when there is no current requirement, enabling remote follow-up later.

## External discovery
Google Places/Routes are used when `GOOGLE_MAPS_API_KEY` is configured. The application retains an OSM-based fallback where supported. External places are not automatically treated as registered team properties.

## Environment variables
- `DATABASE_URL` — Render PostgreSQL Internal Database URL
- `GOOGLE_MAPS_API_KEY` — Google Maps Platform key for Places/Routes
- `GEMINI_API_KEY` — Gemini key for Ask and extraction
- `SEED_CSV=synthetic_field_visits_110_records.csv`
- `DEMO_MODE=true` for the synthetic demo

Never commit real company information, personal data, passwords, API keys or `.env` files.
