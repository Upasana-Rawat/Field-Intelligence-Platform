"""Field Intelligence V2 API.

The browser is a single-page application. This module provides deterministic
business/data operations, external place discovery, routing and the bounded
AI endpoints. Secrets stay server-side.
"""
import os
import math
from datetime import date
from typing import Optional

import requests
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import aliases
import db
import discover
import extract
import geo
import tools
import agent

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
app = FastAPI(title="Field Intelligence V2")

REPS = ["Rep A", "Rep B", "Rep C", "Rep D"]
LIVE = {"SPACE_SHORTAGE", "DEMAND_CAPACITY_MISMATCH", "OPERATIONAL_INEFFICIENCY",
        "FUTURE_OPPORTUNITY", "SITE_AVAILABLE", "ACCOUNT_AT_RISK"}
_con = None

def _valid_coord(lat, lon):
    try:
        lat, lon = float(lat), float(lon)
        return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180
    except (TypeError, ValueError):
        return False


def con():
    global _con
    if _con is None:
        _con = db.connect()
        first = _con.execute("SELECT COUNT(*) c FROM properties").fetchone()["c"] == 0
        db.ensure_seeded(_con)
        if first:
            aliases.apply_confirmed(_con)
    return _con


def status_of(visits):
    outs = {v["outcome_category"] for v in visits}
    if outs & {"ACTIVE_CLIENT", "ACCOUNT_AT_RISK"}:
        return "client"
    if outs & LIVE:
        return "live"
    if "FOLLOW_UP_PENDING" in outs or any(
            v["follow_up_state"] not in ("", "none", "contact_shared") for v in visits):
        return "pending"
    if "COMPETITOR_LOCKED" in outs:
        return "locked"
    if any(v["access_blocked"] for v in visits):
        return "blocked"
    return "dead"


def index_rows():
    """One compact summary row per internal property."""
    c = con()
    out = []
    rows = c.execute("SELECT * FROM properties ORDER BY property_name").fetchall()
    for p in rows:
        h = tools.get_visit_history(c, p["property_id"])
        v = h["visits"]
        last_visit = max([x["visit_date"] or x["visit_month"] for x in v] or [""])
        out.append({
            "id": p["property_id"], "name": p["property_name"],
            "area": p["area"] or "", "territory": p["territory"] or "",
            "type": p["property_type"] or "", "brand": p["brand"] or "",
            "branch": p["branch"] or "", "address": p["parent_site"] or "",
            "lat": p["latitude"], "lon": p["longitude"],
            "conf": p["location_confidence"] or "", "coord_source": p["coord_source"] or "",
            "status": status_of(v), "reps": h["reps_involved"], "visits": len(v),
            "last": last_visit,
            "req": next((x["requirement_detail"] for x in reversed(v) if x["requirement_detail"]), ""),
            "vendor": next((x["competitor_vendor"] for x in reversed(v) if x["competitor_vendor"]), ""),
        })
    return out


def _match_external(place, internal):
    """Match an external POI to an internal property without guessing too aggressively."""
    best = None
    best_score = 0.0
    for p in internal:
        if not p.get("lat") or place.get("lat") is None:
            continue
        d = tools.haversine_m(place["lat"], place["lon"], p["lat"], p["lon"])
        name_a = "".join(ch for ch in place.get("name", "").lower() if ch.isalnum())
        name_b = "".join(ch for ch in p.get("name", "").lower() if ch.isalnum())
        from difflib import SequenceMatcher
        sim = SequenceMatcher(None, name_a, name_b).ratio()
        score = sim
        if d <= 80:
            score += 0.55
        elif d <= 180:
            score += 0.30
        elif d <= 350:
            score += 0.15
        if score > best_score:
            best_score, best = score, p
    if best and best_score >= 0.82:
        d = tools.haversine_m(place["lat"], place["lon"], best["lat"], best["lon"])
        return {"property_id": best["id"], "distance_m": round(d), "confidence": min(1.0, best_score / 1.5)}
    return None


@app.get("/api/bootstrap")
def bootstrap():
    rows = index_rows()
    fu = tools.get_open_followups(con(), limit=500)
    gaps = tools.find_cross_rep_gaps(con())
    return {
        "reps": REPS,
        "properties": rows,
        "stats": {
            "properties": len(rows),
            "visits": con().execute("SELECT COUNT(*) c FROM visits").fetchone()["c"],
            "live": sum(1 for r in rows if r["status"] == "live"),
            "clients": sum(1 for r in rows if r["status"] == "client"),
            "followups": len(fu), "overlaps": len(gaps),
            "located": sum(1 for r in rows if r["lat"] is not None),
        },
        "followups": fu, "overlaps": gaps,
        "outcomes": extract.OUTCOMES, "follow_states": extract.FOLLOW_UPS,
        "discovery": {"provider": "google" if discover.GOOGLE_KEY else "osm",
                      "google_enabled": bool(discover.GOOGLE_KEY)},
    }


@app.get("/api/property/{pid}")
def property_detail(pid: int):
    h = tools.get_visit_history(con(), pid)
    if not h:
        raise HTTPException(404, "no such property")
    p = h["property"]
    near = []
    if p["latitude"] is not None:
        near = tools.find_nearby(con(), p["latitude"], p["longitude"], 700,
                                 exclude_property_id=pid)[:10]
    return {"property": dict(p), "visits": h["visits"],
            "reps": h["reps_involved"], "nearby": near,
            "overlap": tools.check_rep_overlap(con(), pid, "")}


@app.get("/api/nearby")
def nearby(lat: float, lon: float, radius: int = 1000, limit: int = 60):
    if not _valid_coord(lat, lon):
        raise HTTPException(400, "Invalid latitude/longitude")
    radius = max(100, min(int(radius), 50000))
    limit = max(1, min(int(limit), 100))
    internal_raw = tools.find_nearby(con(), lat, lon, radius, limit)
    summaries = {p["id"]: p for p in index_rows()}
    internal = []
    for row in internal_raw:
        x = summaries.get(row["property_id"], {}).copy()
        x.update({"property_id": row["property_id"], "property_name": row["property_name"],
                  "area": row.get("area", ""), "property_type": row.get("property_type", ""),
                  "latitude": row.get("latitude"), "longitude": row.get("longitude"),
                  "distance_m": row.get("distance_m", 0)})
        internal.append(x)
    ext, provider = discover.search_nearby(lat, lon, radius, min(limit, 50))
    for x in ext:
        x["match"] = _match_external(x, summaries)
        x["unvisited"] = x["match"] is None
    return {"internal": internal, "external": ext, "provider": provider}


@app.get("/api/search")
def search(q: str = "", limit: int = 40):
    return {"results": tools.find_property(con(), q, limit)}


@app.get("/api/place-search")
def place_search(q: str, lat: float | None = None, lon: float | None = None):
    internal = tools.find_property(con(), q, 8)
    external, provider = discover.search_text(q, lat, lon, 8)
    if not external:
        external = geo.search(q)
        provider = "photon" if external else provider
    return {"internal": internal, "external": external, "provider": provider}


@app.get("/api/place/{place_id}")
def place_detail(place_id: str):
    if place_id.startswith("google:"):
        p = discover.google_details(place_id.split(":", 1)[1])
        if not p:
            raise HTTPException(404, "place not found")
        p["match"] = _match_external(p, index_rows())
        return p
    raise HTTPException(404, "place not found")


@app.get("/api/discovered")
def discovered(lat: float | None = None, lon: float | None = None, radius: int = 3000):
    if (lat is None) != (lon is None):
        raise HTTPException(400, "Latitude and longitude must be supplied together")
    if lat is not None and lon is not None:
        if not _valid_coord(lat, lon):
            raise HTTPException(400, "Invalid latitude/longitude")
        radius = max(100, min(int(radius), 50000))
    if lat is not None and lon is not None:
        places, provider = discover.search_nearby(lat, lon, radius, 100)
        internal = index_rows()
        for p in places:
            p["match"] = _match_external(p, internal)
            p["unvisited"] = p["match"] is None
        return {"places": [p for p in places if p["unvisited"]], "provider": provider}
    df = discover.load_discovered()
    if df.empty:
        return {"places": [], "provider": "osm"}
    internal = index_rows()
    out = []
    for _, r in df.iterrows():
        p = {"external_id": r.get("osm_id", ""), "name": r["name"], "type": r["type"],
             "lat": float(r["latitude"]), "lon": float(r["longitude"]), "source": "osm"}
        if not _match_external(p, internal):
            out.append(p)
    return {"places": out, "provider": "osm"}


@app.get("/api/team")
def team():
    rows = index_rows()
    cover = {}
    for r in rows:
        a = r["area"] or "unrecorded"
        cover.setdefault(a, {"total": 0, "live": 0, "visited": 0})
        cover[a]["total"] += 1
        cover[a]["visited"] += int(r["visits"] > 0)
        cover[a]["live"] += int(r["status"] in ("live", "client"))
    return {"overlaps": tools.find_cross_rep_gaps(con()),
            "followups": tools.get_open_followups(con(), limit=500),
            "coverage": cover, "pending_merges": aliases.pending_candidates(con())}


class VisitIn(BaseModel):
    property_id: int
    rep: str
    outcome_category: str
    remarks: str = ""
    visit_date: str = ""
    requirement_detail: str = ""
    competitor_vendor: str = ""
    pricing_note: str = ""
    contact_role: str = ""
    follow_up_state: str = "none"
    access_blocked: bool = False
    logged_lat: float | None = None
    logged_lon: float | None = None


@app.post("/api/visit")
def add_visit(v: VisitIn):
    return tools.log_visit(con(), v.property_id, v.rep, v.outcome_category, v.remarks,
                           visit_date=v.visit_date, requirement_detail=v.requirement_detail,
                           competitor_vendor=v.competitor_vendor, pricing_note=v.pricing_note,
                           contact_role=v.contact_role, follow_up_state=v.follow_up_state,
                           access_blocked=int(v.access_blocked), logged_lat=v.logged_lat,
                           logged_lon=v.logged_lon)


class PropertyIn(BaseModel):
    name: str = Field(min_length=2)
    area: str = ""
    property_type: str = "commercial"
    latitude: float
    longitude: float
    rep: str = ""
    brand: str = ""
    branch: str = ""


@app.post("/api/property")
def add_property(p: PropertyIn):
    if not _valid_coord(p.latitude, p.longitude):
        raise HTTPException(400, "Valid latitude and longitude are required")
    pid = con().insert(
        """INSERT INTO properties
           (property_name, brand, branch, parent_site, area, territory,
            property_type, latitude, longitude, coord_source,
            location_confidence, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (p.name.strip(), p.brand.strip(), p.branch.strip(), "", p.area.strip(),
         "field_added", p.property_type, p.latitude, p.longitude,
         "rep_pin", "confirmed", p.rep), pk="property_id")
    con().commit()
    db.log_audit(con(), p.rep or "unknown", "add_property", "property", pid,
                 f"{p.name} @ {p.latitude:.5f},{p.longitude:.5f}")
    return {"property_id": pid, "status": "created"}


class FieldEntryIn(BaseModel):
    rep: str
    property_id: int | None = None
    new_property: bool = False
    property_name: str = ""
    area: str = ""
    property_type: str = "commercial"
    brand: str = ""
    branch: str = ""
    latitude: float | None = None
    longitude: float | None = None
    outcome_category: str
    remarks: str = ""
    visit_date: str = ""
    requirement_detail: str = ""
    competitor_vendor: str = ""
    pricing_note: str = ""
    contact_role: str = ""
    follow_up_state: str = "none"
    access_blocked: bool = False


@app.post("/api/field-entry")
def commit_field_entry(v: FieldEntryIn):
    """One confirmation writes either a visit to an existing property or a new
    property plus its first visit as one transaction."""
    if v.new_property:
        if not v.property_name.strip() or v.latitude is None or v.longitude is None:
            raise HTTPException(400, "New property requires name and coordinates")
        result = tools.create_property_and_visit(
            con(),
            {"name": v.property_name, "area": v.area, "property_type": v.property_type,
             "brand": v.brand, "branch": v.branch, "latitude": v.latitude,
             "longitude": v.longitude, "rep": v.rep},
            v.model_dump(),
        )
        return result
    if not v.property_id:
        raise HTTPException(400, "property_id required for an existing property")
    return tools.log_visit(con(), v.property_id, v.rep, v.outcome_category, v.remarks,
                           visit_date=v.visit_date, requirement_detail=v.requirement_detail,
                           competitor_vendor=v.competitor_vendor, pricing_note=v.pricing_note,
                           contact_role=v.contact_role, follow_up_state=v.follow_up_state,
                           access_blocked=int(v.access_blocked), logged_lat=v.latitude,
                           logged_lon=v.longitude)


@app.get("/api/activity")
def activity(limit: int = 30):
    rows = con().execute("""
        SELECT v.visit_id, v.rep, v.outcome_category, v.remarks, v.created_at,
               v.visit_date, p.property_name, p.property_id, p.latitude, p.longitude
        FROM visits v JOIN properties p ON p.property_id = v.property_id
        WHERE v.source = 'app_entry'
        ORDER BY v.created_at DESC LIMIT ?""", (limit,)).fetchall()
    return {"activity": [dict(r) for r in rows]}


@app.get("/api/route")
def route(origin_lat: float, origin_lon: float, points: str, mode: str = "WALK"):
    """Route a small field plan. Google Routes is used when configured; a
    straight-line fallback keeps planning usable when the external API is off."""
    import json
    try:
        stops = json.loads(points)
    except Exception:
        raise HTTPException(400, "points must be JSON")
    stops = [p for p in stops if p.get("lat") is not None and p.get("lon") is not None][:25]
    if not stops:
        return {"provider": "none", "points": [], "distance_m": 0, "duration_s": 0}

    if discover.GOOGLE_KEY:
        origin = {"location": {"latLng": {"latitude": origin_lat, "longitude": origin_lon}}}
        destination = {"location": {"latLng": {"latitude": stops[-1]["lat"], "longitude": stops[-1]["lon"]}}}
        intermediates = [
            {"location": {"latLng": {"latitude": p["lat"], "longitude": p["lon"]}}}
            for p in stops[:-1]
        ]
        body = {"origin": origin, "destination": destination,
                "travelMode": mode if mode in ("WALK", "DRIVE", "TWO_WHEELER", "BICYCLE") else "WALK",
                "languageCode": "en", "units": "METRIC",
                "intermediates": intermediates}
        if len(intermediates) > 1:
            body["optimizeWaypointOrder"] = True
        headers = {"Content-Type": "application/json", "X-Goog-Api-Key": discover.GOOGLE_KEY,
                   "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.optimizedIntermediateWaypointIndex"}
        try:
            r = requests.post("https://routes.googleapis.com/directions/v2:computeRoutes",
                              json=body, headers=headers, timeout=25)
            if r.status_code == 200:
                rr = r.json().get("routes", [{}])[0]
                return {"provider": "google", "distance_m": rr.get("distanceMeters", 0),
                        "duration_s": int(str(rr.get("duration", "0s")).rstrip("s")),
                        "encoded_polyline": (rr.get("polyline") or {}).get("encodedPolyline", ""),
                        "optimized_order": rr.get("optimizedIntermediateWaypointIndex", [])}
        except Exception:
            pass

    # Fallback: straight-line estimate. It is clearly labelled as an estimate.
    seq = [(origin_lat, origin_lon)] + [(p["lat"], p["lon"]) for p in stops]
    total = sum(tools.haversine_m(a, b, c, d) for (a, b), (c, d) in zip(seq, seq[1:]))
    speed = 4.5 if mode == "WALK" else 25
    return {"provider": "estimate", "distance_m": round(total),
            "duration_s": round(total / 1000 / speed * 3600),
            "points": [[a, b] for a, b in seq],
            "warning": "Road/footpath routing is unavailable; distance and time are estimates."}


@app.get("/api/export")
def export_csv():
    df = db.export_frame(con())
    return Response(df.to_csv(index=False), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="field_intelligence_export.csv"'})


@app.post("/api/extract")
async def do_extract(text: str = Form(""), audio: Optional[UploadFile] = File(None)):
    try:
        if audio is not None:
            raw = await audio.read()
            return extract.from_audio(raw, audio.content_type or "audio/webm")
        if not text.strip():
            raise HTTPException(400, "nothing to extract")
        return extract.from_text(text)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


class AskIn(BaseModel):
    question: str
    rep: str = "Rep A"


@app.post("/api/ask")
def do_ask(a: AskIn):
    try:
        return agent.ask(con(), a.question, rep=a.rep)
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/health")
def health():
    c = con()
    props = c.execute("SELECT COUNT(*) c FROM properties").fetchone()["c"]
    visits = c.execute("SELECT COUNT(*) c FROM visits").fetchone()["c"]
    model = "not configured"; model_ok = False
    if os.environ.get("GEMINI_API_KEY", "").strip():
        try:
            import llm
            model = llm.resolve()
            model_ok = True
        except Exception as e:
            model = str(e); model_ok = False
    return {"db": props, "visits": visits, "backend": db.backend(),
            "model_ok": model_ok, "model": model,
            "google_places": bool(discover.GOOGLE_KEY),
            "seed_file": os.path.basename(db.CSV_PATH)}


@app.get("/api/overlap")
def overlap(property_id: int, rep: str):
    return tools.check_rep_overlap(con(), property_id, rep)


if os.path.isdir(STATIC):
    app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def root():
    return FileResponse(os.path.join(STATIC, "index.html"))
