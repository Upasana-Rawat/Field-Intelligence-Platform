FINAL FRONTEND PACKAGE
Replace only:
static/index.html
static/app.js
static/style.css

Do not replace backend/database files.

Key fixes:
- explicit GPS permission request
- Near Me uses /api/nearby with coordinates
- Plan is generated from follow-ups/opportunities/nearby properties
- microphone recording has deterministic start/stop
- audio is uploaded as FormData without an incorrect JSON Content-Type
- /api/extract response populates visit fields
- /api/visit and /api/field-entry are used for saving
- /api/ask is used for the copilot
