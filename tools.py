"""
tools.py — the deterministic core.

Every function here is ordinary Python: no LLM, no randomness, same input
gives the same output every time. The agent decides WHICH of these to call
and with what arguments; it never touches the database directly.

That boundary is deliberate. Distance arithmetic and database writes have
exactly one correct answer, so a language model has nothing to contribute
and plenty to get wrong.
"""

import math
from difflib import SequenceMatcher

EARTH_R_M = 6_371_000


# ------------------------------------------------------------------ geo
def haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_M * math.asin(math.sqrt(a))


def _norm(s):
    return "".join(c for c in (s or "").lower() if c.isalnum() or c == " ").strip()


def _score(query, name, brand="", branch=""):
    q, n = _norm(query), _norm(name)
    if not q or not n:
        return 0.0
    if q == n:
        return 1.0
    base = SequenceMatcher(None, q, n).ratio()
    if q in n or n in q:
        base = max(base, 0.88)
    for extra in (brand, branch):
        if extra and _norm(extra) and _norm(extra) in q:
            base += 0.05
    return min(base, 1.0)


# --------------------------------------------------------------- tool 1
def find_property(con, query, limit=5):
    """Fuzzy-match a spoken or typed property name against known properties.

    Returns the best candidates with a match score. Deliberately returns
    several: if the top two are close, the caller should ask which is meant
    rather than guessing — that ambiguity is real, especially for chains
    when a brand has several branches.
    """
    rows = con.execute("SELECT * FROM properties").fetchall()
    scored = []
    for r in rows:
        s = _score(query, r["property_name"], r["brand"], r["branch"])
        if s > 0.45:
            d = dict(r)
            d["match_score"] = round(s, 3)
            scored.append(d)
    scored.sort(key=lambda d: -d["match_score"])
    return scored[:limit]


# --------------------------------------------------------------- tool 2
def get_visit_history(con, property_id):
    """Every recorded visit to one property, oldest first, with property detail."""
    prop = con.execute(
        "SELECT * FROM properties WHERE property_id=?", (property_id,)).fetchone()
    if not prop:
        return None
    visits = con.execute(
        """SELECT * FROM visits WHERE property_id=?
           ORDER BY CASE WHEN visit_date='' THEN 1 ELSE 0 END, visit_date""",
        (property_id,)).fetchall()
    return {
        "property": dict(prop),
        "visit_count": len(visits),
        "reps_involved": sorted({v["rep"] for v in visits}),
        "visits": [dict(v) for v in visits],
    }


# --------------------------------------------------------------- tool 3
def find_nearby(con, lat, lon, radius_m=1000, limit=15, exclude_property_id=None):
    """Properties within radius_m of a point, nearest first.

    Linear scan over ~158 rows. At this size an index would cost more to
    build than it saves; with millions of rows this would want an R-tree.
    """
    out = []
    for r in con.execute(
            "SELECT * FROM properties WHERE latitude IS NOT NULL").fetchall():
        if exclude_property_id and r["property_id"] == exclude_property_id:
            continue
        d = haversine_m(lat, lon, r["latitude"], r["longitude"])
        if d <= radius_m:
            x = dict(r)
            x["distance_m"] = round(d)
            out.append(x)
    out.sort(key=lambda x: x["distance_m"])
    return out[:limit]


# --------------------------------------------------------------- tool 4
def check_rep_overlap(con, property_id, rep):
    """Has anyone else already worked this property, or one very close to it?

    Two distinct signals:
      same_property  — a colleague visited this exact property
      nearby         — a colleague visited something within 300m, which
                       matters at territory boundaries where two reps can
                       unknowingly work the same cluster
    """
    hist = get_visit_history(con, property_id)
    if not hist:
        return {"error": "unknown property_id"}

    others = [v for v in hist["visits"] if v["rep"] != rep]
    mine = [v for v in hist["visits"] if v["rep"] == rep]

    nearby = []
    p = hist["property"]
    if p["latitude"] is not None:
        for n in find_nearby(con, p["latitude"], p["longitude"], 300,
                             exclude_property_id=property_id):
            h = get_visit_history(con, n["property_id"])
            for v in h["visits"]:
                if v["rep"] != rep:
                    nearby.append({
                        "property_name": n["property_name"],
                        "distance_m": n["distance_m"],
                        "rep": v["rep"],
                        "visit_date": v["visit_date"] or v["visit_month"],
                        "outcome": v["outcome_category"],
                    })

    return {
        "property_name": p["property_name"],
        "already_visited_by_others": [
            {"rep": v["rep"], "date": v["visit_date"] or v["visit_month"],
             "outcome": v["outcome_category"], "remarks": v["remarks"],
             "contact_role": v["contact_role"]}
            for v in others],
        "my_previous_visits": [
            {"date": v["visit_date"] or v["visit_month"],
             "outcome": v["outcome_category"]} for v in mine],
        "nearby_activity_300m": nearby[:5],
        "duplicate_risk": bool(others),
    }


# --------------------------------------------------------------- tool 5
def get_open_followups(con, rep=None, limit=25):
    """Commitments with no recorded closure — the things that quietly rot."""
    OPEN = ("revisit_needed", "revisit_2_3_days", "proposal_requested",
            "proposal_pending", "quote_requested", "awaiting_callback",
            "email_follow_up", "coordination_pending", "coordination_required",
            "revisit_next_month", "revisit_6_7_months", "appointment_needed",
            "revisit_head_office", "follow_up_scheduled", "monitor")
    ph = ",".join("?" * len(OPEN))
    sql = f"""SELECT v.*, p.property_name, p.area, p.territory,
                     p.latitude, p.longitude
              FROM visits v JOIN properties p USING(property_id)
              WHERE v.follow_up_state IN ({ph})"""
    args = list(OPEN)
    if rep:
        sql += " AND v.rep = ?"
        args.append(rep)
    sql += " ORDER BY v.visit_date DESC LIMIT ?"
    args.append(limit)
    return [dict(r) for r in con.execute(sql, args).fetchall()]


# --------------------------------------------------------------- tool 6
def log_visit(con, property_id, rep, outcome_category, remarks,
              visit_date="", requirement_detail="", competitor_vendor="",
              pricing_note="", contact_role="", follow_up_state="",
              access_blocked=0, record_type="prospect_visit",
              logged_lat=None, logged_lon=None):
    """Write a new visit record. Called only after the rep confirms.

    logged_lat/lon record where the rep physically was when they logged it,
    which is not the same as where the property is — useful later for spotting
    notes written from the office rather than the doorstep.
    """
    import db as _db
    vid = con.insert(
        """INSERT INTO visits
           (property_id, rep, visit_date, visit_month, date_precision,
            record_type, outcome_category, access_blocked, follow_up_state,
            requirement_detail, competitor_vendor, pricing_note,
            contact_role, remarks, source, logged_lat, logged_lon)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (property_id, rep, visit_date, visit_date[:7] if visit_date else "",
         "exact" if visit_date else "unknown", record_type, outcome_category,
         int(access_blocked), follow_up_state, requirement_detail,
         competitor_vendor, pricing_note, contact_role, remarks, "app_entry",
         logged_lat, logged_lon),
        pk="visit_id")
    con.commit()
    _db.log_audit(con, rep, "log_visit", "visit", vid,
                  f"property={property_id} outcome={outcome_category}")
    return {"visit_id": vid, "status": "written"}


# ------------------------------------------------------- cross-rep insight
def find_cross_rep_gaps(con):
    """Properties visited by more than one rep — where knowledge should have
    flowed between them but had no channel to travel through."""
    rows = con.execute(
        """SELECT property_id, COUNT(DISTINCT rep) n
           FROM visits GROUP BY property_id HAVING n > 1""").fetchall()
    out = []
    for r in rows:
        h = get_visit_history(con, r["property_id"])
        out.append({
            "property_name": h["property"]["property_name"],
            "reps": h["reps_involved"],
            "visits": [{"rep": v["rep"],
                        "date": v["visit_date"] or v["visit_month"],
                        "outcome": v["outcome_category"],
                        "contact_role": v["contact_role"],
                        "remarks": v["remarks"][:160]} for v in h["visits"]],
        })
    return out

# ---------------------------------------------------------- V2 workflows
def create_property_and_visit(con, property_data, visit_data):
    """Atomically create a new property and its first visit.

    The rep confirms one draft in the UI; this function writes both records
    together so a half-created field entry cannot be left behind.
    """
    import db as _db
    try:
        pid = con.insert(
            """INSERT INTO properties
               (property_name, brand, branch, parent_site, area, territory,
                property_type, latitude, longitude, coord_source,
                location_confidence, created_by)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                property_data.get("name", "").strip(),
                property_data.get("brand", "").strip(),
                property_data.get("branch", "").strip(),
                property_data.get("parent_site", "").strip(),
                property_data.get("area", "").strip(),
                property_data.get("territory", "field_added").strip(),
                property_data.get("property_type", "commercial").strip(),
                property_data.get("latitude"), property_data.get("longitude"),
                "rep_pin", "confirmed", property_data.get("rep", "unknown"),
            ), pk="property_id")

        vid = con.insert(
            """INSERT INTO visits
               (property_id, rep, visit_date, visit_month, date_precision,
                record_type, outcome_category, access_blocked, follow_up_state,
                requirement_detail, competitor_vendor, pricing_note,
                contact_role, remarks, source, logged_lat, logged_lon)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                pid, visit_data.get("rep", "unknown"), visit_data.get("visit_date", ""),
                (visit_data.get("visit_date", "") or "")[:7],
                "exact" if visit_data.get("visit_date") else "unknown",
                "prospect_visit", visit_data.get("outcome_category", ""),
                int(bool(visit_data.get("access_blocked", False))),
                visit_data.get("follow_up_state", "none"),
                visit_data.get("requirement_detail", ""),
                visit_data.get("competitor_vendor", ""), visit_data.get("pricing_note", ""),
                visit_data.get("contact_role", ""), visit_data.get("remarks", ""),
                "app_entry", visit_data.get("logged_lat"), visit_data.get("logged_lon"),
            ), pk="visit_id")

        con.commit()
        _db.log_audit(con, property_data.get("rep", "unknown"),
                      "create_property_and_visit", "property", pid,
                      f"property={property_data.get('name','')} visit={vid}")
        return {"property_id": pid, "visit_id": vid, "status": "written"}
    except Exception:
        con.rollback()
        raise
